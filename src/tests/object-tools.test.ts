/**
 * Pure-function tests for MssqlObjectTools (no DB connection required).
 *
 * Validates: tool registration, name dispatch, schema generation, and Zod validation
 * behavior for cross-database arguments.
 *
 * Run with: npm run test:object-tools
 */

import { z } from 'zod/v4';
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
	'list_stored_procedures', 'get_procedure_definition',
	'list_views', 'get_view_definition',
	'list_functions', 'get_function_definition',
	'list_triggers', 'get_trigger_definition',
	'get_object_dependencies', 'get_referenced_objects',
];
for (const t of expectedTools) check(`canHandle: ${t}`, MssqlObjectTools.canHandle(t), true);
check('canHandle: unknown_tool returns false', MssqlObjectTools.canHandle('unknown_tool'), false);
check('canHandle: existing MssqlTools name (exec_sql_csv) returns false', MssqlObjectTools.canHandle('exec_sql_csv'), false);

console.log('\n--- getToolDefinitions ---');
const defs = MssqlObjectTools.getToolDefinitions();
check('exposes 10 tool definitions', defs.length, 10);

const names = new Set(defs.map((d) => d.name));
for (const t of expectedTools) check(`definition exists: ${t}`, names.has(t), true);

const procDef = defs.find((d) => d.name === 'list_stored_procedures')!;
check('procedures has inputSchema', typeof procDef.inputSchema, 'object');
check('procedures inputSchema has database_name property', !!(procDef.inputSchema as any).properties?.database_name, true);
check('procedures inputSchema has schema_name property', !!(procDef.inputSchema as any).properties?.schema_name, true);
check('procedures inputSchema has include_system property', !!(procDef.inputSchema as any).properties?.include_system, true);

const defDef = defs.find((d) => d.name === 'get_procedure_definition')!;
check('definition has name property', !!(defDef.inputSchema as any).properties?.name, true);
check('definition has offset_lines property', !!(defDef.inputSchema as any).properties?.offset_lines, true);
check('definition has max_lines property', !!(defDef.inputSchema as any).properties?.max_lines, true);

const triggersDef = defs.find((d) => d.name === 'list_triggers')!;
check('triggers has table_name property (not schema_name)', !!(triggersDef.inputSchema as any).properties?.table_name, true);

console.log('\n--- handler dispatch routes correctly (catches via simulated invalid pool) ---');
// Use a stub pool that throws — we just want to verify dispatch routes correctly,
// not that the SQL executes. Errors are caught and returned as content.
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

console.log('\n--- 3-part name in definition tools is rejected ---');
async function expect3PartRejection(toolName: string): Promise<void> {
	const r = await MssqlObjectTools.handleTool(toolName, { name: 'MyDB.dbo.MyObj' }, stubPool);
	const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
	checkContains(`${toolName} rejects 3-part name`, text, 'is not allowed');
}
await expect3PartRejection('get_procedure_definition');
await expect3PartRejection('get_view_definition');
await expect3PartRejection('get_function_definition');
await expect3PartRejection('get_trigger_definition');
await expect3PartRejection('get_object_dependencies');
await expect3PartRejection('get_referenced_objects');

console.log('\n--- invalid database_name rejected ---');
const badDb = await MssqlObjectTools.handleTool('list_stored_procedures', { database_name: 'foo; DROP TABLE x' }, stubPool);
const badDbText = badDb.content[0]?.type === 'text' ? badDb.content[0].text : '';
checkContains('rejects database_name with SQL injection chars', badDbText, 'Invalid database name');

console.log('\n--- empty name rejected ---');
const emptyName = await MssqlObjectTools.handleTool('get_procedure_definition', { name: '' }, stubPool);
const emptyNameText = emptyName.content[0]?.type === 'text' ? emptyName.content[0].text : '';
checkContains('rejects empty name', emptyNameText, 'Error');

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
