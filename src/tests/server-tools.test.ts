/**
 * Pure-function tests for MssqlServerTools (no DB connection required).
 * Run with: npm run test:server-tools
 */

import { MssqlServerTools } from '../MssqlServerTools.js';

let pass = 0;
let fail = 0;

function check(name: string, actual: unknown, expected: unknown): void {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) {
		pass++;
		console.log(`✅ ${name}`);
	} else {
		fail++;
		console.error(`❌ ${name}\n   expected: ${JSON.stringify(expected)}\n   actual:   ${JSON.stringify(actual)}`);
	}
}

function checkContains(name: string, haystack: string, needle: string): void {
	if (haystack.includes(needle)) {
		pass++;
		console.log(`✅ ${name}`);
	} else {
		fail++;
		console.error(`❌ ${name} — expected to contain "${needle}", got: ${haystack.substring(0, 200)}`);
	}
}

console.log('\n--- canHandle ---');
const expected = ['list_databases', 'list_schemas', 'list_linked_servers', 'get_server_info'];
for (const t of expected) check(`canHandle: ${t}`, MssqlServerTools.canHandle(t), true);
check('canHandle: unknown returns false', MssqlServerTools.canHandle('foo'), false);
check('canHandle: list_stored_procedures (object tool) returns false', MssqlServerTools.canHandle('list_stored_procedures'), false);

console.log('\n--- getToolDefinitions ---');
const defs = MssqlServerTools.getToolDefinitions();
check('exposes 4 tool definitions', defs.length, 4);

const dbProps = (defs.find((d) => d.name === 'list_databases')!.inputSchema as any).properties || {};
check('list_databases has include_system property', !!dbProps.include_system, true);
check('list_databases does NOT have database_name (server-level tool)', !!dbProps.database_name, false);

const schemaProps = (defs.find((d) => d.name === 'list_schemas')!.inputSchema as any).properties || {};
check('list_schemas has database_name property (cross-DB)', !!schemaProps.database_name, true);

const lsProps = (defs.find((d) => d.name === 'list_linked_servers')!.inputSchema as any).properties || {};
check('list_linked_servers has no parameters', Object.keys(lsProps).length, 0);

const siProps = (defs.find((d) => d.name === 'get_server_info')!.inputSchema as any).properties || {};
check('get_server_info has no parameters', Object.keys(siProps).length, 0);

console.log('\n--- handler dispatch with stub pool ---');
const stubPool: any = {
	query: async () => {
		throw new Error('STUB_QUERY_FAIL');
	},
};

async function expectErrorContent(toolName: string, args: any, expectedSubstring: string): Promise<void> {
	const r = await MssqlServerTools.handleTool(toolName, args, stubPool);
	const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
	checkContains(`dispatch: ${toolName}`, text, expectedSubstring);
}

await expectErrorContent('list_databases', {}, 'STUB_QUERY_FAIL');
await expectErrorContent('list_schemas', {}, 'STUB_QUERY_FAIL');
await expectErrorContent('list_linked_servers', {}, 'STUB_QUERY_FAIL');
await expectErrorContent('get_server_info', {}, 'STUB_QUERY_FAIL');

console.log('\n--- list_schemas rejects invalid database_name ---');
const badDb = await MssqlServerTools.handleTool('list_schemas', { database_name: 'foo; DROP' }, stubPool);
const badDbText = badDb.content[0]?.type === 'text' ? badDb.content[0].text : '';
checkContains('rejects malicious database_name', badDbText, 'Invalid database name');

console.log('\n--- get_server_info graceful degradation when dm_os_sys_info fails ---');
let callCount = 0;
const partialPool: any = {
	query: async (sql: string) => {
		callCount++;
		if (sql.includes('dm_os_sys_info')) {
			throw new Error('The user does not have permission to perform this action.');
		}
		// SERVERPROPERTY query — return synthetic result
		return [{
			product_version: '16.0.0.0',
			edition: 'Enterprise',
			collation: 'SQL_Latin1_General_CP1_CI_AS',
			machine_name: 'TEST',
			server_name: 'TEST',
			language: 'us_english',
			is_clustered: 0,
		}];
	},
};
const siResult = await MssqlServerTools.handleTool('get_server_info', {}, partialPool);
const siText = siResult.content[0]?.type === 'text' ? siResult.content[0].text : '';
checkContains('server_info includes SERVERPROPERTY data', siText, '16.0.0.0');
checkContains('server_info includes graceful note about VIEW SERVER STATE', siText, 'VIEW SERVER STATE');
check('partialPool was called twice (props + os_info)', callCount, 2);

console.log('\n--- list_linked_servers permission-denied returns friendly message ---');
const permDeniedPool: any = {
	query: async () => {
		throw new Error('SELECT permission denied on the object servers');
	},
};
const lsResult = await MssqlServerTools.handleTool('list_linked_servers', {}, permDeniedPool);
const lsText = lsResult.content[0]?.type === 'text' ? lsResult.content[0].text : '';
checkContains('linked_servers permission error returns friendly text', lsText, '🔒');
checkContains('linked_servers friendly text includes GRANT hint', lsText, 'GRANT SELECT');

console.log('\n--- unknown tool throws ---');
try {
	await MssqlServerTools.handleTool('does_not_exist', {}, stubPool);
	fail++;
	console.error('❌ should have thrown');
} catch (e) {
	const msg = e instanceof Error ? e.message : '';
	if (msg.includes('Unknown tool')) {
		pass++;
		console.log('✅ unknown tool throws "Unknown tool"');
	} else {
		fail++;
		console.error(`❌ wrong error: ${msg}`);
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
