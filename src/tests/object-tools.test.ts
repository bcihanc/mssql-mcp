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
	'get_object_definition',
	'search_object_definitions',
	'get_object_dependencies',
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
	'get_referenced_objects',
];
for (const t of removedTools) check(`canHandle: removed ${t} returns false`, MssqlObjectTools.canHandle(t), false);

console.log('\n--- getToolDefinitions ---');
const defs = MssqlObjectTools.getToolDefinitions();
check('exposes 7 tool definitions (4 list + definition + search + dependencies)', defs.length, 7);

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

const defDef = defs.find((d) => d.name === 'get_object_definition')!;
check('get_object_definition has object_name property', !!(defDef.inputSchema as any).properties?.object_name, true);
check('get_object_definition has connection_name property', !!(defDef.inputSchema as any).properties?.connection_name, true);

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

console.log('\n--- get_object_definition branches (controlled stub) ---');

// Stub whose query() returns different rows for the main query vs the
// HAS_PERMS_BY_NAME follow-up query, keyed by SQL content.
function defStub(mainRows: any[], permRows: any[] = []): any {
	return {
		name: 'test',
		query: async (sql: string) => (sql.includes('HAS_PERMS_BY_NAME') ? permRows : mainRows),
	};
}

async function callDef(args: any, stub: any): Promise<string> {
	MssqlObjectTools.clearCachesForTesting();
	const r = await MssqlObjectTools.handleTool('get_object_definition', args, stub);
	return r.content[0]?.type === 'text' ? r.content[0].text : '';
}

// Happy path: definition present -> paginated header + body
{
	const body = 'CREATE PROCEDURE [dbo].[GetUsers]\nAS\nBEGIN\nSELECT 1\nEND';
	const text = await callDef({ object_name: 'dbo.GetUsers' }, defStub([{ type_desc: 'SQL_STORED_PROCEDURE', is_module: 1, definition: body }]));
	checkContains('happy path: paginated header', text, '📄 dbo.GetUsers — lines 1-5 of 5');
	checkContains('happy path: body returned', text, 'CREATE PROCEDURE [dbo].[GetUsers]');
}

// Schema defaults to dbo when object_name has no schema part
{
	const text = await callDef({ object_name: 'GetUsers' }, defStub([{ type_desc: 'SQL_STORED_PROCEDURE', is_module: 1, definition: 'CREATE PROC x AS SELECT 1' }]));
	checkContains('no-schema input defaults to dbo in header', text, '📄 dbo.GetUsers');
}

// Object not found (no rows)
{
	const text = await callDef({ object_name: 'dbo.Missing' }, defStub([]));
	checkContains('not found message', text, 'Object not found: dbo.Missing');
}

// is_module = 0 (a table) -> no SQL definition
{
	const text = await callDef({ object_name: 'dbo.Orders' }, defStub([{ type_desc: 'USER_TABLE', is_module: 0, definition: null }]));
	checkContains('non-module: type in message', text, 'is a USER_TABLE');
	checkContains('non-module: no SQL definition', text, 'no SQL definition');
}

// definition NULL + has_perm = 0 -> permission message
{
	const text = await callDef({ object_name: 'dbo.Hidden' }, defStub([{ type_desc: 'SQL_STORED_PROCEDURE', is_module: 1, definition: null }], [{ has_perm: 0 }]));
	checkContains('null+no-perm: lacks VIEW DEFINITION', text, 'lacks VIEW DEFINITION permission');
}

// definition NULL + has_perm = 1 -> encrypted message
{
	const text = await callDef({ object_name: 'dbo.Encrypted' }, defStub([{ type_desc: 'SQL_STORED_PROCEDURE', is_module: 1, definition: null }], [{ has_perm: 1 }]));
	checkContains('null+has-perm: encrypted', text, 'encrypted (WITH ENCRYPTION)');
}

// Cross-DB (database_name given) + definition NULL -> combined message, HAS_PERMS skipped
{
	const text = await callDef({ object_name: 'dbo.X', database_name: 'OtherDB' }, defStub([{ type_desc: 'SQL_STORED_PROCEDURE', is_module: 1, definition: null }]));
	checkContains('cross-db null: combined message', text, 'lacks VIEW DEFINITION permission, or the object is encrypted');
}

// 3-part object_name rejected with a clear message (parses OK but our policy rejects)
{
	const text = await callDef({ object_name: 'MyDB.dbo.proc' }, defStub([]));
	checkContains('3-part object_name rejected', text, 'has 3 parts');
}

// Invalid object_name (parseObjectName throws) -> clean error
{
	const text = await callDef({ object_name: 'a;drop' }, defStub([]));
	checkContains('invalid object_name: parse error surfaced', text, 'Invalid object name');
}

console.log('\n--- search_object_definitions (controlled stub) ---');

// Capture stub: records every SQL text, returns canned rows.
function searchStub(rows: any[]): any {
	const queries: string[] = [];
	return {
		name: 'test',
		queries,
		query: async (sql: string) => {
			queries.push(sql);
			return rows;
		},
	};
}

async function callSearch(args: any, stub: any): Promise<string> {
	MssqlObjectTools.clearCachesForTesting();
	const r = await MssqlObjectTools.handleTool('search_object_definitions', args, stub);
	return r.content[0]?.type === 'text' ? r.content[0].text : '';
}

// Happy path: rows returned as CSV + scope note
{
	const stub = searchStub([{ schema_name: 'dbo', object_name: 'GetUsers', object_type: 'SQL_STORED_PROCEDURE', match_count: 3, modify_date: '2026-01-01' }]);
	const text = await callSearch({ search_text: 'OrderDetail' }, stub);
	checkContains('search happy path: CSV contains object', text, 'GetUsers');
	checkContains('search happy path: scope note appended', text, 'cannot be searched');
	checkContains('search SQL: LIKE with lowered literal', stub.queries[0], "LIKE LOWER(N'%OrderDetail%') ESCAPE '\\'");
	checkContains('search SQL: TOP 100 limit', stub.queries[0], 'SELECT TOP 100');
	checkContains('search SQL: N-prefixed literal for Unicode safety', stub.queries[0], "N'%");
}

// Wildcards are escaped -> literal match
{
	const stub = searchStub([]);
	await callSearch({ search_text: '100%_[x]' }, stub);
	checkContains('search SQL: % escaped', stub.queries[0], '\\%');
	checkContains('search SQL: _ escaped', stub.queries[0], '\\_');
	checkContains('search SQL: [ escaped', stub.queries[0], '\\[');
}

// Single quotes are doubled
{
	const stub = searchStub([]);
	await callSearch({ search_text: "a'b" }, stub);
	checkContains('search SQL: quote doubled', stub.queries[0], "a''b");
}

// object_type filter maps to sys.objects type codes
{
	const stub = searchStub([]);
	await callSearch({ search_text: 'x', object_type: 'procedure' }, stub);
	checkContains('search SQL: procedure type filter', stub.queries[0], "o.type IN ('P')");
}
{
	const stub = searchStub([]);
	await callSearch({ search_text: 'x', object_type: 'function' }, stub);
	checkContains('search SQL: function type filter', stub.queries[0], "o.type IN ('FN','IF','TF','AF','FS','FT')");
}

// Whitespace-only search_text rejected (also guards LEN() division by zero)
{
	const text = await callSearch({ search_text: '   ' }, searchStub([]));
	checkContains('whitespace-only search_text rejected', text, 'cannot be empty');
}

// Empty result message
{
	const text = await callSearch({ search_text: 'zzz_yok' }, searchStub([]));
	checkContains('no match message', text, "No objects found containing 'zzz_yok'");
}

// TOP 100 cap note when exactly 100 rows return
{
	const hundred = Array.from({ length: 100 }, (_, i) => ({ schema_name: 'dbo', object_name: `P${i}`, object_type: 'SQL_STORED_PROCEDURE', match_count: 1, modify_date: '2026-01-01' }));
	const text = await callSearch({ search_text: 'x' }, searchStub(hundred));
	checkContains('cap note at 100 rows', text, 'limited to 100');
}

// schema_name filter + cross-DB prefix reach the SQL
{
	const stub = searchStub([]);
	await callSearch({ search_text: 'x', schema_name: 'sales', database_name: 'OtherDB' }, stub);
	checkContains('search SQL: schema filter', stub.queries[0], "s.name = 'sales'");
	checkContains('search SQL: cross-db prefix', stub.queries[0], '[OtherDB].sys.sql_modules');
}

// Cache: second identical call returns cached marker without re-querying
{
	const stub = searchStub([{ schema_name: 'dbo', object_name: 'GetUsers', object_type: 'SQL_STORED_PROCEDURE', match_count: 1, modify_date: '2026-01-01' }]);
	await MssqlObjectTools.handleTool('search_object_definitions', { search_text: 'cached' }, stub); // warm (no clear!)
	const r2 = await MssqlObjectTools.handleTool('search_object_definitions', { search_text: 'cached' }, stub);
	const text2 = r2.content[0]?.type === 'text' ? r2.content[0].text : '';
	checkContains('search cache hit marker', text2, '📋 (Cached result)');
	check('search cache: only one SQL executed', stub.queries.length, 1);
}

console.log('\n--- get_object_dependencies (controlled stub) ---');

// Routes by SQL content: exists-check vs uses vs used_by (see Interfaces contract).
function depsStub(existsRows: any[], usesRows: any[] = [], usedByRows: any[] = []): any {
	const queries: string[] = [];
	return {
		name: 'test',
		queries,
		query: async (sql: string) => {
			queries.push(sql);
			if (sql.includes("'uses' AS direction")) return usesRows;
			if (sql.includes("'used_by' AS direction")) return usedByRows;
			return existsRows;
		},
	};
}

async function callDeps(args: any, stub: any): Promise<string> {
	MssqlObjectTools.clearCachesForTesting();
	const r = await MssqlObjectTools.handleTool('get_object_dependencies', args, stub);
	return r.content[0]?.type === 'text' ? r.content[0].text : '';
}

const usesRow = { direction: 'uses', schema_name: 'dbo', object_name: 'Orders', object_type: 'USER_TABLE', referenced_database: null, is_unresolved: 0 };
const usedByRow = { direction: 'used_by', schema_name: 'dbo', object_name: 'vw_Sales', object_type: 'VIEW', referenced_database: null, is_unresolved: 0 };

// both (default): rows from both queries, three SQL calls (exists + uses + used_by)
{
	const stub = depsStub([{ object_id: 1 }], [usesRow], [usedByRow]);
	const text = await callDeps({ object_name: 'dbo.GetUsers' }, stub);
	checkContains('deps both: uses row present', text, 'Orders');
	checkContains('deps both: used_by row present', text, 'vw_Sales');
	checkContains('deps both: limits note', text, 'Dynamic SQL');
	check('deps both: 3 queries executed', stub.queries.length, 3);
}

// direction=uses: used_by query never executed
{
	const stub = depsStub([{ object_id: 1 }], [usesRow], [usedByRow]);
	const text = await callDeps({ object_name: 'dbo.GetUsers', direction: 'uses' }, stub);
	checkContains('deps uses: uses row present', text, 'Orders');
	check('deps uses: only 2 queries (exists + uses)', stub.queries.length, 2);
	check('deps uses: no used_by SQL', stub.queries.some((q: string) => q.includes("'used_by' AS direction")), false);
}

// Object not found
{
	const text = await callDeps({ object_name: 'dbo.Missing' }, depsStub([]));
	checkContains('deps not found', text, 'Object not found: dbo.Missing');
}

// No recorded dependencies
{
	const text = await callDeps({ object_name: 'dbo.Lonely' }, depsStub([{ object_id: 1 }], [], []));
	checkContains('deps empty message', text, 'No recorded dependencies for dbo.Lonely');
}

// 3-part object_name rejected
{
	const text = await callDeps({ object_name: 'MyDB.dbo.proc' }, depsStub([{ object_id: 1 }]));
	checkContains('deps 3-part rejected', text, 'has 3 parts');
}

// used_by SQL contains name-based unresolved fallback
{
	const stub = depsStub([{ object_id: 1 }], [], []);
	await callDeps({ object_name: 'dbo.Orders', direction: 'used_by' }, stub);
	const usedBySql = stub.queries.find((q: string) => q.includes("'used_by' AS direction"))!;
	checkContains('used_by SQL: id match', usedBySql, 'd.referenced_id = 1');
	checkContains('used_by SQL: name fallback', usedBySql, "d.referenced_entity_name = 'Orders'");
	checkContains('used_by SQL: is_unresolved flag computed', usedBySql, 'CASE WHEN d.referenced_id IS NULL THEN 1 ELSE 0 END AS is_unresolved');
	checkContains('used_by SQL: name fallback guarded against cross-db/server', usedBySql, 'AND d.referenced_database_name IS NULL AND d.referenced_server_name IS NULL');
}

// Cross-DB: numeric object_id is used directly (no unbracketed 4-part OBJECT_ID string)
{
	const stub = depsStub([{ object_id: 1 }], [], []);
	await callDeps({ object_name: 'dbo.X', database_name: 'OtherDB', direction: 'uses' }, stub);
	const usesSql = stub.queries.find((q: string) => q.includes("'uses' AS direction"))!;
	checkContains('cross-db numeric object_id', usesSql, 'd.referencing_id = 1');
	checkContains('cross-db catalog prefix', usesSql, '[OtherDB].sys.sql_expression_dependencies');
}

// Non-numeric object_id from exists-check -> error surfaced, no SQL interpolation of the raw string
{
	const stub = depsStub([{ object_id: 'abc' }]);
	const text = await callDeps({ object_name: 'dbo.Weird' }, stub);
	checkContains('deps non-numeric object_id: error surfaced', text, 'error');
	check('deps non-numeric object_id: no uses/used_by query executed', stub.queries.length, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
