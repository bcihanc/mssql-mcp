/**
 * Tests for operational features: query timeout, token efficiency,
 * clear_cache, and multi-connection resources (no DB connection required).
 * Run with: npm run test:operations
 */

import { getMssqlConfig, parseConnectionConfigs } from '../server/config.js';
import { ResilientConnectionPool } from '../server/connection.js';
import { MssqlTools } from '../MssqlTools.js';

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

console.log('\n--- requestTimeout config parsing ---');
{
	const baseEnv = { MSSQL_SERVER: 's', MSSQL_DATABASE: 'd', MSSQL_USER: 'u', MSSQL_PASSWORD: 'p' };
	const cfg = getMssqlConfig({ ...baseEnv, MSSQL_REQUEST_TIMEOUT: '45000' } as any);
	check('MSSQL_REQUEST_TIMEOUT parsed (ms)', cfg.requestTimeout, 45000);

	const cfg2 = getMssqlConfig({ ...baseEnv, MSSQL_REQUEST_TIMEOUT: 'abc' } as any);
	check('invalid MSSQL_REQUEST_TIMEOUT ignored', cfg2.requestTimeout, undefined);

	const flatEnv: any = {
		MSSQL_CONN_prod_SERVER: 'ps',
		MSSQL_CONN_prod_DATABASE: 'pd',
		MSSQL_CONN_prod_USER: 'pu',
		MSSQL_CONN_prod_PASSWORD: 'pp',
		MSSQL_CONN_prod_REQUEST_TIMEOUT: '60000',
	};
	const parsed = parseConnectionConfigs(flatEnv);
	check('flat MSSQL_CONN_<name>_REQUEST_TIMEOUT parsed', parsed.connections.get('prod')?.requestTimeout, 60000);

	const flatNoTimeout: any = {
		MSSQL_CONN_prod_SERVER: 'ps',
		MSSQL_CONN_prod_DATABASE: 'pd',
		MSSQL_CONN_prod_USER: 'pu',
		MSSQL_CONN_prod_PASSWORD: 'pp',
		MSSQL_REQUEST_TIMEOUT: '45000',
	};
	const parsed2 = parseConnectionConfigs(flatNoTimeout);
	check('global MSSQL_REQUEST_TIMEOUT is per-connection fallback', parsed2.connections.get('prod')?.requestTimeout, 45000);

	const jsonEnv: any = {
		MSSQL_CONNECTIONS: JSON.stringify({ connections: { j: { server: 'js', database: 'jd', user: 'ju', password: 'jp', requestTimeout: 70000 } } }),
	};
	const parsed3 = parseConnectionConfigs(jsonEnv);
	check('JSON blob requestTimeout parsed', parsed3.connections.get('j')?.requestTimeout, 70000);
}

console.log('\n--- cancel-timer timeout enforcement ---');
{
	const dummyConfig: any = { server: 'x', database: 'd', user: 'u', password: 'p', port: 1433, encrypt: false, command: 'execute_sql', windowsAuth: false, requestTimeout: 30000 };
	const rp = new ResilientConnectionPool(dummyConfig, 'timeout-test');

	let cancelCalled = false;
	let rejectFn: (e: Error) => void = () => {};
	const hangingRequest = {
		query: () => new Promise((_res, rej) => { rejectFn = rej; }),
		cancel: () => { cancelCalled = true; rejectFn(new Error('Canceled.')); },
	};
	(rp as any).pool = { request: () => hangingRequest, close: async () => {} };
	(rp as any).connected = true;

	let threw = false;
	try {
		await rp.query('SELECT 1', { timeoutMs: 50 });
	} catch (e) {
		threw = true;
		checkContains('timeout error message', (e as Error).message, 'timeout and was cancelled');
	}
	check('timed-out query throws', threw, true);
	check('request.cancel() was invoked', cancelCalled, true);
	check('cancel NOT classified as connection loss (still connected)', rp.isConnected, true);

	// fast success path: timer must not fire / cancel must not be called
	let fastCancel = false;
	const fastRequest = {
		query: async () => ({ recordset: [{ a: 1 }] }),
		cancel: () => { fastCancel = true; },
	};
	(rp as any).pool = { request: () => fastRequest, close: async () => {} };
	const rows = await rp.query('SELECT 2', { timeoutMs: 5000 });
	check('fast query returns rows', rows.length, 1);
	check('fast query never cancelled', fastCancel, false);
	await rp.close();
}

console.log('\n--- exec_sql_csv timeout_seconds threading ---');
{
	let capturedOptions: any = 'unset';
	const fakePool: any = { name: 'opsA', query: async (_sql: string, options?: any) => { capturedOptions = options; return [{ x: 1 }]; } };

	await MssqlTools.handleTool('exec_sql_csv', { query: 'SELECT 1 AS one', timeout_seconds: 120 }, fakePool);
	check('timeout_seconds=120 → timeoutMs=120000', capturedOptions?.timeoutMs, 120000);

	capturedOptions = 'unset';
	await MssqlTools.handleTool('exec_sql_csv', { query: 'SELECT 2 AS two' }, fakePool);
	check('no timeout_seconds → options undefined', capturedOptions, undefined);

	const bad = await MssqlTools.handleTool('exec_sql_csv', { query: 'SELECT 3 AS three', timeout_seconds: 500 }, fakePool);
	checkContains('timeout_seconds > 300 rejected by Zod', bad.content[0].text as string, 'Invalid arguments');
}

// --- summary (KEEP LAST — later tasks append sections ABOVE this block) ---
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
