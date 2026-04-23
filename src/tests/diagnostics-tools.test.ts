/**
 * Pure-function tests for MssqlDiagnosticsTools (no DB connection required).
 * Run with: npm run test:diagnostics-tools
 */

import { MssqlDiagnosticsTools } from '../MssqlDiagnosticsTools.js';

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
		console.error(`❌ ${name} — expected "${needle}", got: ${haystack.substring(0, 200)}`);
	}
}

console.log('\n--- canHandle ---');
const expected = [
	'list_sql_agent_jobs', 'get_job_steps', 'get_job_history', 'list_job_schedules',
	'get_index_usage_stats', 'get_missing_indexes', 'get_top_expensive_queries',
	'get_active_sessions', 'get_blocking_sessions', 'get_wait_stats',
];
for (const t of expected) check(`canHandle: ${t}`, MssqlDiagnosticsTools.canHandle(t), true);
check('canHandle: unknown', MssqlDiagnosticsTools.canHandle('foo'), false);

console.log('\n--- getToolDefinitions ---');
const defs = MssqlDiagnosticsTools.getToolDefinitions();
check('exposes 10 tool definitions', defs.length, 10);
const names = new Set(defs.map((d) => d.name));
for (const t of expected) check(`definition exists: ${t}`, names.has(t), true);

console.log('\n--- permission denied returns friendly message ---');
const permPool: any = {
	query: async () => {
		throw new Error('The user does not have permission to perform this action.');
	},
};
async function expectPermDenied(toolName: string, args: any, requiredPermSubstring: string): Promise<void> {
	const r = await MssqlDiagnosticsTools.handleTool(toolName, args, permPool);
	const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
	checkContains(`${toolName} permission-denied has 🔒 emoji`, text, '🔒');
	checkContains(`${toolName} cites required permission`, text, requiredPermSubstring);
}
await expectPermDenied('list_sql_agent_jobs', {}, 'msdb.dbo.sysjobs');
await expectPermDenied('get_job_steps', { job_name: 'X' }, 'sysjobsteps');
await expectPermDenied('get_job_history', { job_name: 'X' }, 'sysjobhistory');
await expectPermDenied('list_job_schedules', {}, 'sysschedules');
await expectPermDenied('get_index_usage_stats', {}, 'VIEW DATABASE STATE');
await expectPermDenied('get_missing_indexes', {}, 'VIEW SERVER STATE');
await expectPermDenied('get_top_expensive_queries', {}, 'VIEW SERVER STATE');
await expectPermDenied('get_active_sessions', {}, 'VIEW SERVER STATE');
await expectPermDenied('get_blocking_sessions', {}, 'VIEW SERVER STATE');
await expectPermDenied('get_wait_stats', {}, 'VIEW SERVER STATE');

console.log('\n--- non-permission errors propagate as "Error" ---');
const stubPool: any = {
	query: async () => {
		throw new Error('STUB_FAIL_other');
	},
};
const r = await MssqlDiagnosticsTools.handleTool('list_sql_agent_jobs', {}, stubPool);
const rText = r.content[0]?.type === 'text' ? r.content[0].text : '';
checkContains('non-perm error returned', rText, 'STUB_FAIL_other');

console.log('\n--- top hard cap ---');
let captured = '';
const capPool: any = {
	query: async (sql: string) => {
		captured = sql;
		return [];
	},
};
await MssqlDiagnosticsTools.handleTool('get_top_expensive_queries', { top: 99999 }, capPool);
checkContains('top capped at 100', captured, 'TOP 100 ');
captured = '';
await MssqlDiagnosticsTools.handleTool('get_missing_indexes', { top: 99999 }, capPool);
checkContains('missing_indexes top capped at 100', captured, 'TOP 100 ');
captured = '';
await MssqlDiagnosticsTools.handleTool('get_wait_stats', { top: 99999 }, capPool);
checkContains('wait_stats top capped at 100', captured, 'TOP 100 ');

console.log('\n--- get_job_history limit clamp ---');
captured = '';
await MssqlDiagnosticsTools.handleTool('get_job_history', { job_name: 'X', limit: 9999 }, capPool);
checkContains('job_history limit capped at 200', captured, 'TOP 200 ');

console.log('\n--- order_by enum validation ---');
const badOrder = await MssqlDiagnosticsTools.handleTool('get_top_expensive_queries', { order_by: 'malicious; DROP TABLE x' }, stubPool);
const badOrderText = badOrder.content[0]?.type === 'text' ? badOrder.content[0].text : '';
checkContains('order_by rejects non-enum value', badOrderText, 'Error');

console.log('\n--- get_active_sessions adds note when only 1 session visible ---');
const onePool: any = {
	query: async () => [{ session_id: 54, login_name: 'me', host_name: 'h', program_name: 'p', status: 'running' }],
};
const ses = await MssqlDiagnosticsTools.handleTool('get_active_sessions', {}, onePool);
const sesText = ses.content[0]?.type === 'text' ? ses.content[0].text : '';
checkContains('active_sessions notes single-session visibility', sesText, 'VIEW SERVER STATE');

console.log('\n--- list_sql_agent_jobs success path ---');
MssqlDiagnosticsTools.clearCachesForTesting();
const jobsPool: any = {
	query: async () => [
		{ job_id: 'abc', name: 'NightlyBackup', enabled: 1, owner_login: 'sa' },
		{ job_id: 'def', name: 'IndexRebuild', enabled: 0, owner_login: 'sa' },
	],
};
const jobs = await MssqlDiagnosticsTools.handleTool('list_sql_agent_jobs', {}, jobsPool);
const jobsText = jobs.content[0]?.type === 'text' ? jobs.content[0].text : '';
checkContains('jobs list shows job names', jobsText, 'NightlyBackup');
checkContains('jobs list shows owner', jobsText, 'sa');

console.log('\n--- get_job_history run_status decoded ---');
const histPool: any = {
	query: async () => [
		{ step_id: 1, step_name: 's1', run_datetime: '2026-04-23', run_duration: 100, run_status: 'Succeeded', message: 'OK' },
	],
};
const hist = await MssqlDiagnosticsTools.handleTool('get_job_history', { job_name: 'X' }, histPool);
const histText = hist.content[0]?.type === 'text' ? hist.content[0].text : '';
checkContains('job history shows decoded status', histText, 'Succeeded');

console.log('\n--- get_blocking_sessions clean state ---');
const noBlocksPool: any = {
	query: async () => [],
};
const nb = await MssqlDiagnosticsTools.handleTool('get_blocking_sessions', {}, noBlocksPool);
const nbText = nb.content[0]?.type === 'text' ? nb.content[0].text : '';
checkContains('no blocking shows clean message', nbText, 'No blocking');

console.log('\n--- get_index_usage_stats with database_name ---');
captured = '';
await MssqlDiagnosticsTools.handleTool('get_index_usage_stats', { database_name: 'MyDB' }, capPool);
checkContains('index_usage uses bracketed db prefix', captured, '[MyDB].sys.dm_db_index_usage_stats');
checkContains('index_usage uses DB_ID() literal', captured, "DB_ID('MyDB')");

console.log('\n--- invalid database_name rejected ---');
const badDb = await MssqlDiagnosticsTools.handleTool('get_index_usage_stats', { database_name: 'bad; DROP' }, stubPool);
const badDbText = badDb.content[0]?.type === 'text' ? badDb.content[0].text : '';
checkContains('rejects malicious database_name', badDbText, 'Invalid database name');

console.log('\n--- unknown tool throws ---');
try {
	await MssqlDiagnosticsTools.handleTool('does_not_exist', {}, stubPool);
	fail++;
	console.error('❌ should have thrown');
} catch (e) {
	const msg = e instanceof Error ? e.message : '';
	if (msg.includes('Unknown tool')) {
		pass++;
		console.log('✅ unknown tool throws');
	} else {
		fail++;
		console.error(`❌ wrong error: ${msg}`);
	}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
