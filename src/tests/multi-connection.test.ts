/**
 * Manual tests for multi-connection support.
 * Run with: node --loader ts-node/esm src/tests/multi-connection.test.ts
 */

import { z } from 'zod/v4';
import { namespaceCacheKey, validateConnectionName } from '../utils/identifier.js';
import { ConnectionScopeSchema } from '../utils/connectionScope.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
