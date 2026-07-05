/**
 * Pure-function tests for get_table_schema MS_Description support (no DB required).
 *
 * Uses a capture stub; distinct table names per case avoid cache collisions.
 *
 * Run with: npm run test:schema-description
 */

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
		console.error(`❌ ${name} — expected to contain "${needle}", got: ${haystack.substring(0, 300)}`);
	}
}

// Column query returns columnRows; the table-description query (contains
// 'table_description') returns descRows. All SQL texts are captured.
function schemaStub(columnRows: any[], descRows: any[]): any {
	const queries: string[] = [];
	return {
		name: 'test',
		queries,
		query: async (sql: string) => {
			queries.push(sql);
			return sql.includes('table_description') ? descRows : columnRows;
		},
	};
}

async function callSchema(tableName: string, stub: any): Promise<string> {
	const r = await MssqlTools.handleGetTableSchema({ table_name: tableName }, stub);
	return r.content[0]?.type === 'text' ? r.content[0].text : '';
}

const colRow = { Column: 'Id', DataType: 'int', MaxLength: null, Nullable: 'NO', Default: null, PrimaryKey: 'YES', ForeignKey: 'NO', UniqueKey: 'NO', Computed: 'NO', ComputedExpression: null, Position: 1, Description: 'Birincil anahtar' };

console.log('\n--- get_table_schema description support ---');

// Main query includes the extended_properties join keyed by column_id (NOT ordinal position)
{
	const stub = schemaStub([colRow], []);
	await callSchema('T1', stub);
	checkContains('main SQL: extended_properties join', stub.queries[0], 'sys.extended_properties');
	checkContains('main SQL: MS_Description filter', stub.queries[0], "ep.name = 'MS_Description'");
	checkContains('main SQL: column_id join (not ordinal)', stub.queries[0], 'ep.minor_id = col.column_id');
	checkContains('main SQL: Description column selected', stub.queries[0], 'AS [Description]');
}

// Description value flows into CSV output
{
	const stub = schemaStub([colRow], []);
	const text = await callSchema('T2', stub);
	checkContains('CSV: Description header present', text, 'Description');
	checkContains('CSV: description value present', text, 'Birincil anahtar');
}

// Table-level description prepended when present
{
	const stub = schemaStub([colRow], [{ table_description: 'Sipariş satırları' }]);
	const text = await callSchema('T3', stub);
	check('table description line first', text.startsWith('Table description: Sipariş satırları'), true);
}

// No table description -> output unchanged (starts with CSV header)
{
	const stub = schemaStub([colRow], []);
	const text = await callSchema('T4', stub);
	check('no description line when absent', text.startsWith('Table description:'), false);
}

// Description query failure is swallowed (graceful degrade)
{
	const queries: string[] = [];
	const stub: any = {
		name: 'test',
		queries,
		query: async (sql: string) => {
			queries.push(sql);
			if (sql.includes('table_description')) throw new Error('EP_DENIED');
			return [colRow];
		},
	};
	const text = await callSchema('T5', stub);
	checkContains('graceful degrade: columns still returned', text, 'Birincil anahtar');
	check('graceful degrade: no error text', text.includes('EP_DENIED'), false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
