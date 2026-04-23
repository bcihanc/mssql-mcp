/**
 * Pure-function tests for MssqlProfilingTools (no DB connection required).
 * Run with: npm run test:profiling-tools
 */

import { MssqlProfilingTools } from '../MssqlProfilingTools.js';

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
const expected = ['profile_column', 'get_table_sample', 'get_table_row_count'];
for (const t of expected) check(`canHandle: ${t}`, MssqlProfilingTools.canHandle(t), true);
check('canHandle: unknown', MssqlProfilingTools.canHandle('foo'), false);

console.log('\n--- getToolDefinitions ---');
const defs = MssqlProfilingTools.getToolDefinitions();
check('exposes 3 tool definitions', defs.length, 3);

const profileProps = (defs.find((d) => d.name === 'profile_column')!.inputSchema as any).properties || {};
check('profile_column has table_name', !!profileProps.table_name, true);
check('profile_column has column_name', !!profileProps.column_name, true);
check('profile_column has database_name', !!profileProps.database_name, true);
check('profile_column has sample_size', !!profileProps.sample_size, true);

const sampleProps = (defs.find((d) => d.name === 'get_table_sample')!.inputSchema as any).properties || {};
check('get_table_sample has sample_rows', !!sampleProps.sample_rows, true);

const rcProps = (defs.find((d) => d.name === 'get_table_row_count')!.inputSchema as any).properties || {};
check('get_table_row_count has exact', !!rcProps.exact, true);

console.log('\n--- handler dispatch with stub pool ---');
const stubPool: any = {
	query: async () => {
		throw new Error('STUB_QUERY_FAIL');
	},
};

async function expectErrorContent(toolName: string, args: any, expectedSubstring: string): Promise<void> {
	const r = await MssqlProfilingTools.handleTool(toolName, args, stubPool);
	const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
	checkContains(`dispatch: ${toolName}`, text, expectedSubstring);
}

await expectErrorContent('profile_column', { table_name: 'dbo.x', column_name: 'col' }, 'could not aggregate');
await expectErrorContent('get_table_sample', { table_name: 'dbo.x' }, 'STUB_QUERY_FAIL');

console.log('\n--- 3-part name rejection ---');
const r1 = await MssqlProfilingTools.handleTool('profile_column', { table_name: 'MyDB.dbo.x', column_name: 'c' }, stubPool);
checkContains('profile_column rejects 3-part table_name', r1.content[0]!.type === 'text' ? r1.content[0]!.text : '', 'is not allowed');
const r2 = await MssqlProfilingTools.handleTool('get_table_sample', { table_name: 'MyDB.dbo.x' }, stubPool);
checkContains('get_table_sample rejects 3-part table_name', r2.content[0]!.type === 'text' ? r2.content[0]!.text : '', 'is not allowed');
const r3 = await MssqlProfilingTools.handleTool('get_table_row_count', { table_name: 'MyDB.dbo.x' }, stubPool);
checkContains('get_table_row_count rejects 3-part table_name', r3.content[0]!.type === 'text' ? r3.content[0]!.text : '', 'is not allowed');

console.log('\n--- column_name validation (SQL injection) ---');
const colInj = await MssqlProfilingTools.handleTool('profile_column', { table_name: 'dbo.x', column_name: 'col; DROP TABLE y' }, stubPool);
checkContains('profile_column rejects malicious column_name', colInj.content[0]!.type === 'text' ? colInj.content[0]!.text : '', 'Invalid column_name');

console.log('\n--- get_table_sample hard cap on sample_rows ---');
let capturedQuery = '';
const capturePool: any = {
	query: async (sql: string) => {
		capturedQuery = sql;
		return [{ a: 1 }];
	},
};
await MssqlProfilingTools.handleTool('get_table_sample', { table_name: 'dbo.x', sample_rows: 99999 }, capturePool);
checkContains('sample_rows hard-capped at 100', capturedQuery, 'TOP 100 *');

console.log('\n--- get_table_row_count three-tier fallback ---');
let queryCount = 0;
const fallbackPool: any = {
	query: async (sql: string) => {
		queryCount++;
		if (sql.includes('dm_db_partition_stats')) {
			throw new Error('VIEW DATABASE STATE permission denied');
		}
		if (sql.includes('sysindexes')) {
			return [{ rowcnt: 0 }]; // Returns 0 → must fall through to COUNT_BIG
		}
		if (sql.includes('COUNT_BIG')) {
			return [{ cnt: 12345 }];
		}
		return [];
	},
};
const rcResult = await MssqlProfilingTools.handleTool('get_table_row_count', { table_name: 'dbo.x' }, fallbackPool);
const rcText = rcResult.content[0]!.type === 'text' ? rcResult.content[0]!.text : '';
checkContains('row_count uses COUNT_BIG fallback', rcText, '12345');
checkContains('row_count cites fallback source', rcText, 'fallback after metadata returned 0');
check('three queries attempted (DMV → sysindexes → COUNT_BIG)', queryCount, 3);

console.log('\n--- get_table_row_count exact mode skips fast tiers ---');
let exactQueryCount = 0;
let exactQuerySql = '';
const exactPool: any = {
	query: async (sql: string) => {
		exactQueryCount++;
		exactQuerySql = sql;
		return [{ cnt: 999 }];
	},
};
const exactResult = await MssqlProfilingTools.handleTool('get_table_row_count', { table_name: 'dbo.x', exact: true }, exactPool);
const exactText = exactResult.content[0]!.type === 'text' ? exactResult.content[0]!.text : '';
check('exact mode runs only 1 query', exactQueryCount, 1);
checkContains('exact mode uses COUNT_BIG', exactQuerySql, 'COUNT_BIG');
checkContains('exact result includes 999', exactText, '999');

console.log('\n--- profile_column success path (synthetic) ---');
const profilePool: any = {
	query: async (sql: string) => {
		if (sql.includes('TOP 10')) {
			return [
				{ value: 'A', occurrences: 100 },
				{ value: 'B', occurrences: 50 },
			];
		}
		return [{
			row_count: 150,
			null_count: 5,
			null_pct: 3.33,
			distinct_count: 2,
			min_value: 'A',
			max_value: 'B',
		}];
	},
};
const profileResult = await MssqlProfilingTools.handleTool('profile_column', { table_name: 'dbo.x', column_name: 'col' }, profilePool);
const profileText = profileResult.content[0]!.type === 'text' ? profileResult.content[0]!.text : '';
checkContains('profile shows row_count', profileText, '150');
checkContains('profile shows null_pct', profileText, '3.33');
checkContains('profile shows top values header', profileText, 'Top 10');
checkContains('profile shows top value A', profileText, 'A,100');

console.log('\n--- profile_column with sample_size adds note ---');
MssqlProfilingTools.clearCachesForTesting();
const profileSampleResult = await MssqlProfilingTools.handleTool('profile_column', { table_name: 'dbo.x', column_name: 'col', sample_size: 1000 }, profilePool);
const profileSampleText = profileSampleResult.content[0]!.type === 'text' ? profileSampleResult.content[0]!.text : '';
checkContains('sampled profile includes estimate note', profileSampleText, 'random sample of 1000');
checkContains('sampled profile includes "estimates" disclaimer', profileSampleText, 'estimates');

console.log('\n--- unknown tool throws ---');
try {
	await MssqlProfilingTools.handleTool('does_not_exist', {}, stubPool);
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
