/**
 * Tests for MssqlPerformanceTools (no DB connection required).
 * Run with: npm run test:performance-tools
 */

import { MssqlPerformanceTools } from '../MssqlPerformanceTools.js';

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
		console.error(`❌ ${name} — expected to contain "${needle}", got: ${haystack.substring(0, 300)}`);
	}
}

console.log('\n--- canHandle / definitions ---');
check('canHandle get_missing_indexes', MssqlPerformanceTools.canHandle('get_missing_indexes'), true);
check('canHandle get_top_queries', MssqlPerformanceTools.canHandle('get_top_queries'), true);
check('canHandle unknown', MssqlPerformanceTools.canHandle('foo'), false);

const defs = MssqlPerformanceTools.getToolDefinitions();
check('exposes 3 tool definitions', defs.length, 3);
const miProps = (defs.find((d) => d.name === 'get_missing_indexes')!.inputSchema as any).properties || {};
check('get_missing_indexes has database_name', !!miProps.database_name, true);
check('get_missing_indexes has table_name', !!miProps.table_name, true);
check('get_missing_indexes has connection_name', !!miProps.connection_name, true);
const tqProps = (defs.find((d) => d.name === 'get_top_queries')!.inputSchema as any).properties || {};
check('get_top_queries has sort_by', !!tqProps.sort_by, true);
check('get_top_queries has top', !!tqProps.top, true);

console.log('\n--- get_missing_indexes SQL construction ---');
{
	let lastSql = '';
	const capturePool: any = { name: 'perfA', query: async (sql: string) => { lastSql = sql; return [{ table: '[D].[dbo].[T]', equality_columns: '[a]' }]; } };

	await MssqlPerformanceTools.handleTool('get_missing_indexes', {}, capturePool);
	checkContains('joins missing_index_details', lastSql, 'sys.dm_db_missing_index_details');
	checkContains('joins group_stats', lastSql, 'sys.dm_db_missing_index_group_stats');
	checkContains('current DB filter', lastSql, 'mid.database_id = DB_ID()');
	checkContains('ordered by improvement', lastSql, 'ORDER BY improvement_measure DESC');
	check('no OBJECT_ID( anywhere (dotted-DB trap)', lastSql.includes('OBJECT_ID('), false);

	lastSql = '';
	await MssqlPerformanceTools.handleTool('get_missing_indexes', { database_name: 'OtherDB' }, capturePool);
	checkContains('cross-DB filter is N-prefixed literal', lastSql, "DB_ID(N'OtherDB')");

	lastSql = '';
	await MssqlPerformanceTools.handleTool('get_missing_indexes', { table_name: 'sales.Orders', database_name: 'OtherDB2' }, capturePool);
	checkContains('table filter via statement LIKE suffix', lastSql, ".\\[sales].\\[Orders]'");
	checkContains('LIKE is escaped', lastSql, "ESCAPE '\\'");
	checkContains('table filter N-prefixed', lastSql, "LIKE N'%");

	const threePart = await MssqlPerformanceTools.handleTool('get_missing_indexes', { table_name: 'DBX.s.t' }, capturePool);
	checkContains('3-part table_name rejected', threePart.content[0].text as string, 'database_name');

	const permPool: any = { name: 'perfB', query: async () => { throw new Error('VIEW SERVER STATE permission was denied on object'); } };
	const perm = await MssqlPerformanceTools.handleTool('get_missing_indexes', {}, permPool);
	checkContains('permission degradation', perm.content[0].text as string, 'GRANT VIEW SERVER STATE');

	let count = 0;
	const countPool: any = { name: 'perfC', query: async () => { count++; return [{ table: 't' }]; } };
	await MssqlPerformanceTools.handleTool('get_missing_indexes', {}, countPool);
	const second = await MssqlPerformanceTools.handleTool('get_missing_indexes', {}, countPool);
	check('second call served from cache', count, 1);
	checkContains('cached marker', second.content[0].text as string, 'Cached result');
}

console.log('\n--- get_top_queries SQL construction ---');
{
	let lastSql = '';
	let count = 0;
	const capturePool: any = { name: 'perfD', query: async (sql: string) => { lastSql = sql; count++; return [{ query_text: 'SELECT 1', execution_count: 5 }]; } };

	await MssqlPerformanceTools.handleTool('get_top_queries', {}, capturePool);
	checkContains('default TOP 20', lastSql, 'SELECT TOP 20');
	checkContains('default sort avg_elapsed', lastSql, 'ORDER BY qs.total_elapsed_time / qs.execution_count DESC');
	checkContains('reads plan cache stats', lastSql, 'sys.dm_exec_query_stats');

	await MssqlPerformanceTools.handleTool('get_top_queries', { sort_by: 'cpu', top: 50 }, capturePool);
	checkContains('cpu sort', lastSql, 'ORDER BY qs.total_worker_time DESC');
	checkContains('top 50 honored', lastSql, 'SELECT TOP 50');

	const tooMany = await MssqlPerformanceTools.handleTool('get_top_queries', { top: 51 }, capturePool);
	checkContains('top 51 rejected by Zod', tooMany.content[0].text as string, 'Error');

	const dbf = await MssqlPerformanceTools.handleTool('get_top_queries', { database_name: 'FiltDB' }, capturePool);
	checkContains('dbid filter N-prefixed', lastSql, "st.dbid = DB_ID(N'FiltDB')");
	checkContains('ad-hoc NULL dbid note', dbf.content[0].text as string, 'ad-hoc');

	const before = count;
	await MssqlPerformanceTools.handleTool('get_top_queries', {}, capturePool);
	check('get_top_queries is NOT cached', count, before + 1);

	const permPool: any = { name: 'perfE', query: async () => { throw new Error('The user does not have permission to perform this action.'); } };
	const perm = await MssqlPerformanceTools.handleTool('get_top_queries', {}, permPool);
	checkContains('permission degradation', perm.content[0].text as string, 'GRANT VIEW SERVER STATE');
}

console.log('\n--- get_query_plan ---');
{
	check('canHandle get_query_plan', MssqlPerformanceTools.canHandle('get_query_plan'), true);

	// write query rejected BEFORE any connection is opened
	let ephemeralCalls = 0;
	const guardPool: any = {
		name: 'planA',
		query: async () => [],
		createEphemeralConnection: async () => { ephemeralCalls++; throw new Error('should not be called'); },
	};
	const rejected = await MssqlPerformanceTools.handleTool('get_query_plan', { query: 'DROP TABLE x' }, guardPool);
	checkContains('write query rejected', rejected.content[0].text as string, 'READ-ONLY');
	check('no ephemeral connection opened for rejected query', ephemeralCalls, 0);

	// happy path
	const batches: string[] = [];
	const queries: string[] = [];
	let closed = false;
	let dbOverrideSeen: string | undefined = 'unset' as any;
	const happyPool: any = {
		name: 'planB',
		query: async () => [],
		createEphemeralConnection: async (dbOverride?: string) => {
			dbOverrideSeen = dbOverride;
			return {
				batch: async (s: string) => { batches.push(s); },
				query: async (q: string) => { queries.push(q); return [{ 'Microsoft SQL Server 2005 XML Showplan': '<ShowPlanXML>plan</ShowPlanXML>' }]; },
				close: async () => { closed = true; },
			};
		},
	};
	const plan = await MssqlPerformanceTools.handleTool('get_query_plan', { query: 'SELECT 1 AS a', database_name: 'OtherDB' }, happyPool);
	checkContains('plan XML returned', plan.content[0].text as string, '<ShowPlanXML>');
	checkContains('marked as estimated / not executed', plan.content[0].text as string, 'NOT executed');
	check('SHOWPLAN batch sent first', batches[0], 'SET SHOWPLAN_XML ON');
	check('query sent on same ephemeral connection', queries[0], 'SELECT 1 AS a');
	check('database override forwarded', dbOverrideSeen, 'OtherDB');
	check('ephemeral connection closed', closed, true);

	// close() must run even when the query throws (finally)
	let closed2 = false;
	const failPool: any = {
		name: 'planC',
		query: async () => [],
		createEphemeralConnection: async () => ({
			batch: async () => {},
			query: async () => { throw new Error('SHOWPLAN permission denied in database'); },
			close: async () => { closed2 = true; },
		}),
	};
	const permErr = await MssqlPerformanceTools.handleTool('get_query_plan', { query: 'SELECT 2 AS b' }, failPool);
	checkContains('SHOWPLAN permission hint', permErr.content[0].text as string, 'GRANT SHOWPLAN');
	check('connection closed on error too', closed2, true);

	// pool without the method → clear error
	const legacyPool: any = { name: 'planD', query: async () => [] };
	const unsupported = await MssqlPerformanceTools.handleTool('get_query_plan', { query: 'SELECT 3 AS c' }, legacyPool);
	checkContains('unsupported pool message', unsupported.content[0].text as string, 'not supported');

	// 100k truncation
	const bigPool: any = {
		name: 'planE',
		query: async () => [],
		createEphemeralConnection: async () => ({
			batch: async () => {},
			query: async () => [{ plan: '<x>' + 'p'.repeat(100050) + '</x>' }],
			close: async () => {},
		}),
	};
	const big = await MssqlPerformanceTools.handleTool('get_query_plan', { query: 'SELECT 4 AS d' }, bigPool);
	checkContains('oversized plan truncated', big.content[0].text as string, '...[truncated]');
	checkContains('truncation note', big.content[0].text as string, 'Plan truncated at 100000');
}

// --- summary (KEEP LAST — Task 4 appends ABOVE this block) ---
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
