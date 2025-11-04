/**
 * Manual test for error detection logic
 * Tests that schema errors don't trigger false positive write operation detection
 */

// Simulate the error detection logic from connection.ts
function detectErrorType(errorMessage: string): 'schema' | 'write' | 'other' {
	const lower = errorMessage.toLowerCase();

	// FIRST: Check if this is a schema/syntax error
	if (
		lower.includes('invalid column name')
		|| lower.includes('invalid object name')
		|| lower.includes('incorrect syntax near')
		|| lower.includes('could not find stored procedure')
		|| lower.includes('must declare')
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
