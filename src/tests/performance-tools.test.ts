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
check('canHandle get_query_plan', MssqlPerformanceTools.canHandle('get_query_plan'), true);
check('canHandle unknown', MssqlPerformanceTools.canHandle('foo'), false);
// Removed in 2026-07: these must no longer be recognized or exposed.
check('removed get_missing_indexes not handled', MssqlPerformanceTools.canHandle('get_missing_indexes'), false);
check('removed get_top_queries not handled', MssqlPerformanceTools.canHandle('get_top_queries'), false);

const defs = MssqlPerformanceTools.getToolDefinitions();
check('exposes 1 tool definition', defs.length, 1);
const qpProps = (defs.find((d) => d.name === 'get_query_plan')!.inputSchema as any).properties || {};
check('get_query_plan has query', !!qpProps.query, true);
check('get_query_plan has database_name', !!qpProps.database_name, true);
check('get_query_plan has connection_name', !!qpProps.connection_name, true);

check('clearCaches reports zero entries (nothing cached in this layer)', MssqlPerformanceTools.clearCaches(), 0);

console.log('\n--- get_query_plan ---');
{
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
