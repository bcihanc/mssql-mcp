/**
 * Manual tests for cross-database identifier validation and line-based pagination utilities.
 *
 * Run with: node --loader ts-node/esm src/tests/identifier-pagination.test.ts
 */

import { validateTableName } from '../server/config.js';
import {
	buildCacheKeyPrefix,
	parseObjectName,
	validateDatabaseName,
	validateObjectName,
} from '../utils/identifier.js';
import { formatPaginatedResponse, paginateLines } from '../utils/pagination.js';

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

console.log('\n--- validateObjectName ---');
check('1-part', validateObjectName('users'), '[users]');
check('2-part', validateObjectName('dbo.users'), '[dbo].[users]');
check('3-part cross-db', validateObjectName('MyDB.dbo.users'), '[MyDB].[dbo].[users]');
check('underscores allowed', validateObjectName('my_db.my_schema.my_table'), '[my_db].[my_schema].[my_table]');
checkThrows('reject 4-part', () => validateObjectName('a.b.c.d'));
checkThrows('reject empty schema (MyDB..users)', () => validateObjectName('MyDB..users'));
checkThrows('reject leading dot', () => validateObjectName('.users'));
checkThrows('reject trailing dot', () => validateObjectName('users.'));
checkThrows('reject SQL injection ;', () => validateObjectName('users; DROP TABLE x'));
checkThrows('reject brackets in input', () => validateObjectName('[users]'));
checkThrows('reject hyphens', () => validateObjectName('my-table'));
checkThrows('reject empty string', () => validateObjectName(''));

console.log('\n--- parseObjectName ---');
check('parse 1-part', parseObjectName('users'), { object: 'users' });
check('parse 2-part', parseObjectName('dbo.users'), { schema: 'dbo', object: 'users' });
check('parse 3-part', parseObjectName('MyDB.dbo.users'), { database: 'MyDB', schema: 'dbo', object: 'users' });

console.log('\n--- validateDatabaseName ---');
check('simple db name', validateDatabaseName('MyDB'), '[MyDB]');
check('underscore db name', validateDatabaseName('my_db_2'), '[my_db_2]');
checkThrows('reject db with dot', () => validateDatabaseName('My.DB'));
checkThrows('reject db with bracket', () => validateDatabaseName('[MyDB]'));

console.log('\n--- buildCacheKeyPrefix ---');
check('default (no dbContext)', buildCacheKeyPrefix(), '_default_::');
check('with dbContext', buildCacheKeyPrefix('MyDB'), 'mydb::');
check('lowercased for cache hit', buildCacheKeyPrefix('MYDB'), 'mydb::');
checkThrows('reject invalid prefix input', () => buildCacheKeyPrefix('foo; DROP'));

console.log('\n--- paginateLines ---');
const longText = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');

const page1 = paginateLines(longText, { offset_lines: 0, max_lines: 200 });
check('page1 returned_lines', page1.returned_lines, 200);
check('page1 total_lines', page1.total_lines, 500);
check('page1 has_more', page1.has_more, true);
check('page1 next_offset', page1.next_offset, 200);
check('page1 first line', page1.content.split('\n')[0], 'line 1');
check('page1 last line', page1.content.split('\n').at(-1), 'line 200');

const page3 = paginateLines(longText, { offset_lines: 400, max_lines: 200 });
check('page3 returned_lines (last partial)', page3.returned_lines, 100);
check('page3 has_more (false at end)', page3.has_more, false);
check('page3 next_offset undefined', page3.next_offset, undefined);

const past = paginateLines(longText, { offset_lines: 5000, max_lines: 200 });
check('past-end empty content', past.content, '');
check('past-end returned_lines 0', past.returned_lines, 0);
check('past-end has_more false', past.has_more, false);

const defaults = paginateLines(longText);
check('defaults max_lines = 200', defaults.returned_lines, 200);

const overCap = paginateLines(longText, { max_lines: 99999 });
check('hard-cap at 1000', overCap.returned_lines, 500); // 500 < 1000 cap

const negative = paginateLines(longText, { offset_lines: -50, max_lines: -10 });
check('negative offset normalized to 0', negative.offset, 0);
check('negative max normalized to default', negative.returned_lines, 200);

const empty = paginateLines('');
check('empty input total=1 (single empty line)', empty.total_lines, 1);

console.log('\n--- formatPaginatedResponse ---');
const formatted = formatPaginatedResponse(page1, 'dbo.GetUsers');
const firstLine = formatted.split('\n')[0];
check(
	'header has object, range, total, has_more, next_offset',
	firstLine,
	'📄 dbo.GetUsers — lines 1-200 of 500 | has_more=true next_offset=200',
);
const lastPage = formatPaginatedResponse(page3, 'dbo.GetUsers');
check(
	'header omits next_offset when has_more=false',
	lastPage.split('\n')[0],
	'📄 dbo.GetUsers — lines 401-500 of 500 | has_more=false',
);
const pastFmt = formatPaginatedResponse(past, 'dbo.GetUsers');
check(
	'past-end shows friendly message',
	pastFmt,
	'📄 dbo.GetUsers — offset_lines=5000 is past end of definition (total_lines=500).',
);

console.log('\n--- validateTableName (deprecated shim, backward compat) ---');
check('shim: 1-part still works', validateTableName('users'), '[users]');
check('shim: 2-part still works', validateTableName('dbo.users'), '[dbo].[users]');
check('shim: now also supports 3-part', validateTableName('MyDB.dbo.users'), '[MyDB].[dbo].[users]');
checkThrows('shim: still rejects SQL injection', () => validateTableName('users; DROP TABLE x'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
