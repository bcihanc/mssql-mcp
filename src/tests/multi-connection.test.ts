/**
 * Manual tests for multi-connection support.
 * Run with: node --loader ts-node/esm src/tests/multi-connection.test.ts
 */

import { namespaceCacheKey, validateConnectionName } from '../utils/identifier.js';

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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
