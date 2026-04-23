/**
 * Pure-function tests for MssqlObjectTools (no DB connection required).
 *
 * Validates: tool registration, name dispatch, schema generation, and Zod validation
 * behavior for cross-database arguments.
 *
 * Run with: npm run test:object-tools
 */

import { MssqlObjectTools } from '../MssqlObjectTools.js';

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
const expectedTools = [
	'list_stored_procedures',
	'list_views',
	'list_functions',
	'list_triggers',
];
for (const t of expectedTools) check(`canHandle: ${t}`, MssqlObjectTools.canHandle(t), true);
check('canHandle: unknown_tool returns false', MssqlObjectTools.canHandle('unknown_tool'), false);
check('canHandle: existing MssqlTools name (exec_sql_csv) returns false', MssqlObjectTools.canHandle('exec_sql_csv'), false);

// Removed tools — must not be handled
const removedTools = [
	'get_procedure_definition',
	'get_view_definition',
	'get_function_definition',
	'get_trigger_definition',
	'get_object_dependencies',
	'get_referenced_objects',
];
for (const t of removedTools) check(`canHandle: removed ${t} returns false`, MssqlObjectTools.canHandle(t), false);

console.log('\n--- getToolDefinitions ---');
const defs = MssqlObjectTools.getToolDefinitions();
check('exposes 4 tool definitions (definition + dependency tools removed)', defs.length, 4);

const names = new Set(defs.map((d) => d.name));
for (const t of expectedTools) check(`definition exists: ${t}`, names.has(t), true);
for (const t of removedTools) check(`removed tool absent from definitions: ${t}`, names.has(t), false);

const procDef = defs.find((d) => d.name === 'list_stored_procedures')!;
check('procedures has inputSchema', typeof procDef.inputSchema, 'object');
check('procedures inputSchema has database_name property', !!(procDef.inputSchema as any).properties?.database_name, true);
check('procedures inputSchema has schema_name property', !!(procDef.inputSchema as any).properties?.schema_name, true);
check('procedures inputSchema has include_system property', !!(procDef.inputSchema as any).properties?.include_system, true);

const triggersDef = defs.find((d) => d.name === 'list_triggers')!;
check('triggers has table_name property (not schema_name)', !!(triggersDef.inputSchema as any).properties?.table_name, true);

console.log('\n--- handler dispatch routes correctly (catches via simulated invalid pool) ---');
const stubPool: any = {
	query: async () => {
		throw new Error('STUB_QUERY_FAIL');
	},
};

async function callAndExpectErrorContent(toolName: string, args: any, expectedSubstring: string): Promise<void> {
	try {
		const r = await MssqlObjectTools.handleTool(toolName, args, stubPool);
		const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
		checkContains(`dispatch: ${toolName} returns error content`, text, expectedSubstring);
	} catch (e) {
		fail++;
		console.error(`❌ dispatch: ${toolName} threw instead of returning error content: ${e}`);
	}
}

await callAndExpectErrorContent('list_stored_procedures', {}, 'STUB_QUERY_FAIL');
await callAndExpectErrorContent('list_views', {}, 'STUB_QUERY_FAIL');
await callAndExpectErrorContent('list_functions', {}, 'STUB_QUERY_FAIL');
await callAndExpectErrorContent('list_triggers', {}, 'STUB_QUERY_FAIL');

console.log('\n--- invalid database_name rejected ---');
const badDb = await MssqlObjectTools.handleTool('list_stored_procedures', { database_name: 'foo; DROP TABLE x' }, stubPool);
const badDbText = badDb.content[0]?.type === 'text' ? badDb.content[0].text : '';
checkContains('rejects database_name with SQL injection chars', badDbText, 'Invalid database name');

console.log('\n--- removed tool dispatch throws ---');
for (const t of removedTools) {
	try {
		await MssqlObjectTools.handleTool(t, {}, stubPool);
		fail++;
		console.error(`❌ ${t} should throw "Unknown tool" after removal`);
	} catch (e) {
		const msg = e instanceof Error ? e.message : '';
		if (msg.includes('Unknown tool')) {
			pass++;
			console.log(`✅ removed tool ${t} throws "Unknown tool"`);
		} else {
			fail++;
			console.error(`❌ ${t} threw wrong error: ${msg}`);
		}
	}
}

console.log('\n--- unknown tool throws ---');
try {
	await MssqlObjectTools.handleTool('does_not_exist', {}, stubPool);
	fail++;
	console.error('❌ unknown tool should throw');
} catch (e) {
	const msg = e instanceof Error ? e.message : '';
	if (msg.includes('Unknown tool')) {
		pass++;
		console.log('✅ unknown tool throws "Unknown tool" error');
	} else {
		fail++;
		console.error(`❌ unknown tool threw wrong error: ${msg}`);
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
