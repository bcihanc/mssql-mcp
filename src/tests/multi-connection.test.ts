/**
 * Manual tests for multi-connection support.
 * Run with: node --loader ts-node/esm src/tests/multi-connection.test.ts
 */

import { z } from 'zod/v4';
import { namespaceCacheKey, validateConnectionName } from '../utils/identifier.js';
import { ConnectionScopeSchema } from '../utils/connectionScope.js';
import { MssqlTools } from '../MssqlTools.js';
import { MssqlServerTools } from '../MssqlServerTools.js';
import { MssqlObjectTools } from '../MssqlObjectTools.js';
import { MssqlProfilingTools } from '../MssqlProfilingTools.js';
import { MssqlPerformanceTools } from '../MssqlPerformanceTools.js';
import { parseConnectionConfigs } from '../server/config.js';
import { ConnectionRegistry, resolvePoolForCall } from '../server/ConnectionRegistry.js';

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

function checkThrows(name: string, fn: () => unknown): void {
	try {
		fn();
		fail++;
		console.error(`❌ ${name} — expected throw, got no error`);
	} catch {
		pass++;
		console.log(`✅ ${name}`);
	}
}

console.log('\n--- validateConnectionName ---');
check('accepts alphanumeric', validateConnectionName('uretim'), 'uretim');
check('accepts underscore', validateConnectionName('prod_1'), 'prod_1');
check('accepts hyphen', validateConnectionName('prod-2'), 'prod-2');
checkThrows('rejects dot', () => validateConnectionName('a.b'));
checkThrows('rejects space', () => validateConnectionName('a b'));
checkThrows('rejects semicolon', () => validateConnectionName('a;b'));
checkThrows('rejects empty', () => validateConnectionName(''));
checkThrows('rejects brackets', () => validateConnectionName('[a]'));

console.log('\n--- namespaceCacheKey ---');
check('prefixes with connection name', namespaceCacheKey('uretim', 'dbo:users'), 'uretim::dbo:users');
check('different names -> different keys',
	namespaceCacheKey('test', 'x') === namespaceCacheKey('uretim', 'x'), false);

console.log('\n--- ConnectionScopeSchema ---');
{
	const base = z.object({ table_name: z.string() });
	const merged = base.extend(ConnectionScopeSchema.shape);
	const json = z.toJSONSchema(merged) as any;
	check('merged schema exposes connection_name', 'connection_name' in json.properties, true);
	check('merged schema keeps original field', 'table_name' in json.properties, true);
	check('connection_name is optional', (json.required || []).includes('connection_name'), false);
}

console.log('\n--- all tool defs expose connection_name ---');
{
	const allDefs = [
		...MssqlTools.getToolDefinitions(),
		...MssqlServerTools.getToolDefinitions(),
		...MssqlObjectTools.getToolDefinitions(),
		...MssqlProfilingTools.getToolDefinitions(),
		...MssqlPerformanceTools.getToolDefinitions(),
	];
	check('25 tool definitions total', allDefs.length, 25);
	for (const def of allDefs) {
		// list_connections is a registry-level tool, so it doesn't have connection_name
		if (def.name === 'list_connections') continue;
		const props = (def.inputSchema as any).properties || {};
		check(`${def.name} exposes connection_name`, 'connection_name' in props, true);
	}
}

console.log('\n--- parseConnectionConfigs ---');
{
	// Legacy fallback: no MSSQL_CONNECTIONS -> single "default".
	// Passed directly as a synthetic env object (not real process.env) to prove
	// parseConnectionConfigs() is deterministic on its `env` parameter.
	const env = {
		MSSQL_SERVER: 'legacy-host',
		MSSQL_DATABASE: 'db',
		MSSQL_USER: 'u',
		MSSQL_PASSWORD: 'p',
	} as any;
	const legacy = parseConnectionConfigs(env);
	check('legacy -> defaultName is default', legacy.defaultName, 'default');
	check('legacy -> one connection', legacy.connections.size, 1);
	check('legacy -> default server', legacy.connections.get('default')?.server, 'legacy-host');
}
{
	// Multi with explicit default
	const env = {
		MSSQL_CONNECTIONS: JSON.stringify({
			default: 'uretim',
			connections: {
				uretim: { server: 'prod', database: 'S', user: 'u', password: 'p' },
				test: { server: 'test', database: 'S', user: 'u', password: 'p' },
			},
		}),
	} as any;
	const parsed = parseConnectionConfigs(env);
	check('multi -> defaultName', parsed.defaultName, 'uretim');
	check('multi -> two connections', parsed.connections.size, 2);
	check('multi -> test server', parsed.connections.get('test')?.server, 'test');
}
{
	// Single connection, no default -> auto default
	const env = {
		MSSQL_CONNECTIONS: JSON.stringify({
			connections: { only: { server: 'x', database: 'S', user: 'u', password: 'p' } },
		}),
	} as any;
	const parsed = parseConnectionConfigs(env);
	check('single no-default -> auto default', parsed.defaultName, 'only');
}
checkThrows('multi no-default -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: JSON.stringify({
		connections: {
			a: { server: 'x', database: 'S', user: 'u', password: 'p' },
			b: { server: 'y', database: 'S', user: 'u', password: 'p' },
		},
	}),
} as any));
checkThrows('default points to missing -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: JSON.stringify({
		default: 'nope',
		connections: { a: { server: 'x', database: 'S', user: 'u', password: 'p' } },
	}),
} as any));
checkThrows('malformed JSON -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: '{not valid json',
} as any));
checkThrows('empty connections -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: JSON.stringify({ connections: {} }),
} as any));
checkThrows('invalid connection name -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: JSON.stringify({
		connections: { 'bad name': { server: 'x', database: 'S', user: 'u', password: 'p' } },
	}),
} as any));
checkThrows('entry missing server -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: JSON.stringify({
		connections: { a: { database: 'S', user: 'u', password: 'p' } },
	}),
} as any));
checkThrows('entry missing database -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: JSON.stringify({
		connections: { a: { server: 'x', user: 'u', password: 'p' } },
	}),
} as any));
checkThrows('entry missing user/password without windowsAuth -> throws', () => parseConnectionConfigs({
	MSSQL_CONNECTIONS: JSON.stringify({
		connections: { a: { server: 'x', database: 'S' } },
	}),
} as any));
{
	// windowsAuth: true with no user/password succeeds
	const env = {
		MSSQL_CONNECTIONS: JSON.stringify({
			connections: { a: { server: 'x', database: 'S', windowsAuth: true } },
		}),
	} as any;
	const parsed = parseConnectionConfigs(env);
	check('windowsAuth -> windowsAuth is true', parsed.connections.get('a')?.windowsAuth, true);
	check('windowsAuth -> user is undefined', parsed.connections.get('a')?.user, undefined);
	check('windowsAuth -> password is undefined', parsed.connections.get('a')?.password, undefined);
}

console.log('\n--- ConnectionRegistry ---');
{
	const parsed = parseConnectionConfigs({
		MSSQL_CONNECTIONS: JSON.stringify({
			default: 'uretim',
			connections: {
				uretim: { server: 'prod', database: 'S', user: 'u', password: 'p' },
				test: { server: 'test', database: 'S', user: 'v', password: 'p' },
			},
		}),
	} as any);
	const registry = new ConnectionRegistry(parsed);

	check('get() -> default pool name', registry.get().name, 'uretim');
	check('get("test") -> named pool', registry.get('test').name, 'test');
	check('has known', registry.has('test'), true);
	check('has unknown', registry.has('nope'), false);
	checkThrows('get unknown -> throws', () => registry.get('nope'));

	const list = registry.list();
	check('list length', list.length, 2);
	const uretim = list.find((c) => c.name === 'uretim')!;
	check('list exposes server', uretim.server, 'prod');
	check('list exposes user', uretim.user, 'u');
	check('list marks default', uretim.is_default, true);
	check('list has no password field', 'password' in (uretim as any), false);

	// resolvePoolForCall
	check('resolve no arg -> default', resolvePoolForCall(registry, {}).name, 'uretim');
	check('resolve named', resolvePoolForCall(registry, { connection_name: 'test' }).name, 'test');
	checkThrows('resolve invalid name -> throws', () => resolvePoolForCall(registry, { connection_name: 'bad name' }));
	checkThrows('resolve unknown name -> throws', () => resolvePoolForCall(registry, { connection_name: 'nope' }));
}

console.log('\n--- cache isolation (get_version) ---');
{
	// Fake pools returning different versions for the same query
	const poolA: any = { name: 'connA', async query() { return [{ version: 'SQL-A' }]; }, async close() {} };
	const poolB: any = { name: 'connB', async query() { return [{ version: 'SQL-B' }]; }, async close() {} };

	const a1 = await MssqlTools.handleGetVersion(poolA);
	const b1 = await MssqlTools.handleGetVersion(poolB);
	const aText = a1.content[0].text;
	const bText = b1.content[0].text;
	check('poolA returns its own version', aText.includes('SQL-A'), true);
	check('poolB is NOT served poolA cache', bText.includes('SQL-B'), true);
	check('poolB did not get SQL-A', bText.includes('SQL-A'), false);
}

console.log('\n--- list_connections tool ---');
{
	const parsed = parseConnectionConfigs({
		MSSQL_CONNECTIONS: JSON.stringify({
			default: 'uretim',
			connections: {
				uretim: { server: 'prod', database: 'S', user: 'u', password: 'secret-pw' },
				test: { server: 'test', database: 'S', user: 'v', password: 'secret-pw' },
			},
		}),
	} as any);
	const registry = new ConnectionRegistry(parsed);
	const res = MssqlServerTools.handleListConnections(registry);
	const text = res.content[0].text;
	check('lists uretim', text.includes('uretim'), true);
	check('lists test', text.includes('test'), true);
	check('shows server', text.includes('prod'), true);
	check('NEVER leaks password', text.includes('secret-pw'), false);

	// Tool is advertised but NOT routed through the pool path
	const defs = MssqlServerTools.getToolDefinitions();
	check('list_connections advertised', defs.some((d) => d.name === 'list_connections'), true);
	check('list_connections excluded from canHandle', MssqlServerTools.canHandle('list_connections'), false);
}

console.log('\n--- flat MSSQL_CONN_<name>_<FIELD> parsing ---');
{
	// Two connections, one with a hyphenated name — readable per-field env vars.
	const env = {
		MSSQL_DEFAULT_CONNECTION: 'vaay',
		MSSQL_CONN_vaay_SERVER: 'vaay-host',
		MSSQL_CONN_vaay_DATABASE: 'VaayDB',
		MSSQL_CONN_vaay_USER: 'ro',
		MSSQL_CONN_vaay_PASSWORD: 'secret-pw',
		'MSSQL_CONN_aytemiz-com-tr_SERVER': 'web-host',
		'MSSQL_CONN_aytemiz-com-tr_DATABASE': 'WebDB',
		'MSSQL_CONN_aytemiz-com-tr_USER': 'ro',
		'MSSQL_CONN_aytemiz-com-tr_PASSWORD': 'secret-pw',
	} as any;
	const parsed = parseConnectionConfigs(env);
	check('flat -> two connections', parsed.connections.size, 2);
	check('flat -> default from MSSQL_DEFAULT_CONNECTION', parsed.defaultName, 'vaay');
	check('flat -> vaay server', parsed.connections.get('vaay')?.server, 'vaay-host');
	check('flat -> vaay database', parsed.connections.get('vaay')?.database, 'VaayDB');
	check('flat -> hyphenated name parsed', parsed.connections.get('aytemiz-com-tr')?.server, 'web-host');
}
{
	// Single flat connection, no explicit default -> auto default.
	const env = {
		MSSQL_CONN_only_SERVER: 'x',
		MSSQL_CONN_only_DATABASE: 'S',
		MSSQL_CONN_only_USER: 'u',
		MSSQL_CONN_only_PASSWORD: 'p',
	} as any;
	const parsed = parseConnectionConfigs(env);
	check('flat single -> auto default', parsed.defaultName, 'only');
}
{
	// PORT / ENCRYPT / WINDOWS_AUTH coercion.
	const env = {
		MSSQL_CONN_win_SERVER: 'x',
		MSSQL_CONN_win_DATABASE: 'S',
		MSSQL_CONN_win_PORT: '1450',
		MSSQL_CONN_win_ENCRYPT: 'true',
		MSSQL_CONN_win_WINDOWS_AUTH: 'true',
	} as any;
	const parsed = parseConnectionConfigs(env);
	const cfg = parsed.connections.get('win');
	check('flat -> PORT coerced to number', cfg?.port, 1450);
	check('flat -> ENCRYPT coerced to boolean', cfg?.encrypt, true);
	check('flat -> WINDOWS_AUTH true drops user/password', cfg?.windowsAuth, true);
	check('flat -> windowsAuth user undefined', cfg?.user, undefined);
}
checkThrows('flat multi no-default -> throws', () => parseConnectionConfigs({
	MSSQL_CONN_a_SERVER: 'x', MSSQL_CONN_a_DATABASE: 'S', MSSQL_CONN_a_USER: 'u', MSSQL_CONN_a_PASSWORD: 'p',
	MSSQL_CONN_b_SERVER: 'y', MSSQL_CONN_b_DATABASE: 'S', MSSQL_CONN_b_USER: 'u', MSSQL_CONN_b_PASSWORD: 'p',
} as any));
checkThrows('flat missing password (no windowsAuth) -> throws', () => parseConnectionConfigs({
	MSSQL_CONN_a_SERVER: 'x', MSSQL_CONN_a_DATABASE: 'S', MSSQL_CONN_a_USER: 'u',
} as any));
checkThrows('flat unrecognized field -> throws', () => parseConnectionConfigs({
	MSSQL_CONN_a_HOSTNAME: 'x',
} as any));
checkThrows('flat invalid connection name -> throws', () => parseConnectionConfigs({
	'MSSQL_CONN_bad.name_SERVER': 'x',
} as any));
{
	// MSSQL_CONNECTIONS JSON takes precedence over flat vars when both are present.
	const env = {
		MSSQL_CONNECTIONS: JSON.stringify({
			connections: { fromjson: { server: 'json-host', database: 'S', user: 'u', password: 'p' } },
		}),
		MSSQL_CONN_flat_SERVER: 'flat-host',
		MSSQL_CONN_flat_DATABASE: 'S',
		MSSQL_CONN_flat_USER: 'u',
		MSSQL_CONN_flat_PASSWORD: 'p',
	} as any;
	const parsed = parseConnectionConfigs(env);
	check('JSON wins over flat vars', parsed.defaultName, 'fromjson');
	check('flat vars ignored when JSON present', parsed.connections.has('flat'), false);
}

console.log('\n--- MSSQL_DEFAULT_CONNECTION override ---');
{
	const connJson = JSON.stringify({
		default: 'ayt',
		connections: {
			ayt: { server: 'a', database: 'S', user: 'u', password: 'p' },
			portal: { server: 'b', database: 'S', user: 'u', password: 'p' },
		},
	});
	// Override picks a different connection than the JSON "default"
	const overridden = parseConnectionConfigs({ MSSQL_CONNECTIONS: connJson, MSSQL_DEFAULT_CONNECTION: 'portal' } as any);
	check('override wins over JSON default', overridden.defaultName, 'portal');
	// No override falls back to JSON default
	const fallback = parseConnectionConfigs({ MSSQL_CONNECTIONS: connJson } as any);
	check('no override -> JSON default', fallback.defaultName, 'ayt');
	// Override works even when JSON has no "default" and multiple connections exist
	const noJsonDefault = JSON.stringify({
		connections: {
			ayt: { server: 'a', database: 'S', user: 'u', password: 'p' },
			crm: { server: 'c', database: 'S', user: 'u', password: 'p' },
		},
	});
	const viaOverride = parseConnectionConfigs({ MSSQL_CONNECTIONS: noJsonDefault, MSSQL_DEFAULT_CONNECTION: 'crm' } as any);
	check('override supplies default when JSON has none', viaOverride.defaultName, 'crm');
	// Override naming a missing connection throws
	checkThrows('override to unknown connection throws', () => parseConnectionConfigs({ MSSQL_CONNECTIONS: connJson, MSSQL_DEFAULT_CONNECTION: 'nope' } as any));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
