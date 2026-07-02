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
import { parseConnectionConfigs } from '../server/config.js';

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
	];
	check('19 tool definitions total', allDefs.length, 19);
	for (const def of allDefs) {
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
