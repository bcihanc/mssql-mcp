/**
 * Manual test for error detection logic
 * Tests that schema errors don't trigger false positive write operation detection
 */

// Simulate the error detection logic from connection.ts
function detectErrorType(errorMessage: string): 'schema' | 'write' | 'other' {
	const lower = errorMessage.toLowerCase();

	// FIRST: Check if this is a schema/syntax error
	// CRITICAL: This check MUST come BEFORE write operation check
	if (
		lower.includes('invalid column name')
		|| lower.includes('invalid object name')
		|| lower.includes('incorrect syntax near')
		|| lower.includes('could not find stored procedure')
		|| lower.includes('must declare')
		|| lower.includes('ambiguous column name')
	) {
		return 'schema';
	}

	// SECOND: Check if this looks like a write operation
	if (
		lower.includes('insert')
		|| lower.includes('update')
		|| lower.includes('delete')
		|| lower.includes('create')
		|| lower.includes('drop')
		|| lower.includes('alter')
	) {
		return 'write';
	}

	return 'other';
}

// Test cases
const testCases = [
	{
		name: 'Schema error with CreateTime column (FALSE POSITIVE FIX)',
		errorMessage: "Invalid column name 'CreateTime'.",
		expectedType: 'schema',
		description: 'Should detect as schema error, NOT write operation',
	},
	{
		name: 'Schema error with UpdateUser column',
		errorMessage: "Invalid column name 'UpdateUser'.",
		expectedType: 'schema',
		description: 'Should detect as schema error, NOT write operation',
	},
	{
		name: 'Schema error with InsertDate column',
		errorMessage: "Invalid column name 'InsertDate'.",
		expectedType: 'schema',
		description: 'Should detect as schema error, NOT write operation',
	},
	{
		name: 'Schema error - invalid table name',
		errorMessage: "Invalid object name 'Users'.",
		expectedType: 'schema',
		description: 'Should detect as schema error',
	},
	{
		name: 'Schema error - syntax error',
		errorMessage: "Incorrect syntax near 'SELECT'.",
		expectedType: 'schema',
		description: 'Should detect as schema error',
	},
	{
		name: 'Real write operation - INSERT blocked',
		errorMessage: 'Cannot INSERT into table. Permission denied.',
		expectedType: 'write',
		description: 'Should detect as write operation',
	},
	{
		name: 'Real write operation - UPDATE blocked',
		errorMessage: 'UPDATE statement conflicted with FOREIGN KEY constraint.',
		expectedType: 'write',
		description: 'Should detect as write operation',
	},
	{
		name: 'Real write operation - DELETE blocked',
		errorMessage: 'DELETE permission denied on object.',
		expectedType: 'write',
		description: 'Should detect as write operation',
	},
	{
		name: 'Real write operation - CREATE blocked',
		errorMessage: 'CREATE TABLE permission denied.',
		expectedType: 'write',
		description: 'Should detect as write operation (not CreateTime column)',
	},
	{
		name: 'Real write operation - DROP blocked',
		errorMessage: 'DROP TABLE permission denied.',
		expectedType: 'write',
		description: 'Should detect as write operation',
	},
	{
		name: 'Other error - connection timeout',
		errorMessage: 'Connection timeout occurred.',
		expectedType: 'other',
		description: 'Should detect as other error',
	},
	{
		name: 'Schema error - ambiguous column name with CREATE keyword',
		errorMessage: "Ambiguous column name 'CreateDate'.",
		expectedType: 'schema',
		description: 'Should detect as schema error, NOT write operation',
	},
	{
		name: 'Permission denied - SELECT operation',
		errorMessage: "The SELECT permission was denied on the object 'RestrictedTable'.",
		expectedType: 'other',
		description: 'Should detect as other error, NOT write operation',
	},
	{
		name: 'Multi-line error with CREATE keyword',
		errorMessage: "Invalid object name 'Users'.\nCannot find column 'CreateTime'.",
		expectedType: 'schema',
		description: 'Should detect as schema error despite multiline format',
	},
	{
		name: 'Schema error - ambiguous column with UPDATE keyword',
		errorMessage: "Ambiguous column name 'UpdatedAt'.",
		expectedType: 'schema',
		description: 'Should detect as schema error, NOT write operation',
	},
	{
		name: 'Schema error - ambiguous column with INSERT keyword',
		errorMessage: "Ambiguous column name 'InsertedBy'.",
		expectedType: 'schema',
		description: 'Should detect as schema error, NOT write operation',
	},
];

// Run tests
console.log('🧪 Testing Error Detection Logic\n');
console.log('='.repeat(80));
console.log('');

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
	const result = detectErrorType(testCase.errorMessage);
	const success = result === testCase.expectedType;

	if (success) {
		console.log(`✅ PASS: ${testCase.name}`);
		console.log(`   Expected: ${testCase.expectedType}, Got: ${result}`);
		console.log(`   Message: "${testCase.errorMessage}"`);
		passed++;
	} else {
		console.log(`❌ FAIL: ${testCase.name}`);
		console.log(`   Expected: ${testCase.expectedType}, Got: ${result}`);
		console.log(`   Message: "${testCase.errorMessage}"`);
		console.log(`   Description: ${testCase.description}`);
		failed++;
	}
	console.log('');
}

console.log('='.repeat(80));
console.log(`\n📊 Test Results: ${passed} passed, ${failed} failed (${testCases.length} total)`);

if (failed === 0) {
	console.log('✅ All tests passed! Error detection logic is working correctly.');
	process.exit(0);
} else {
	console.log('❌ Some tests failed. Please review the error detection logic.');
	process.exit(1);
}
