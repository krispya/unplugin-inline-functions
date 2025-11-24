import { describe, expect, it } from 'vitest';
import { buildFiles } from './utils/build-files';
import { resolve } from 'path';

describe('@inline functionality', () => {
	it('should inline functions marked with @inline decorator across files', async () => {
		// Build the entry point which imports the inlinable functions
		const entryPoint = resolve(__dirname, 'fixtures/display-user.js');
		const result = await buildFiles(entryPoint);

		const transformedCode = result.outputFiles[0].text;

		// Extract the displayUserInfo function body
		const functionMatch = transformedCode.match(
			/function displayUserInfo\(userId\)\s*\{([\s\S]*?)\n\}/
		);
		expect(functionMatch).toBeTruthy();
		const functionBody = functionMatch![1];

		// The original @inline function calls should not appear in the function body
		expect(functionBody).not.toContain('getUser(');
		expect(functionBody).not.toContain('getUserName(');

		// Instead, the function bodies should be inlined directly
		expect(functionBody).toContain('userCache.get(');
		expect(functionBody).toContain('database.users.find(');
		expect(functionBody).toContain('?.name');
		expect(functionBody).toContain('"Unknown"');
	});

	it('should inline functions called as statements with inverted control flow', async () => {
		// Build the entry point which imports the inlinable functions
		const entryPoint = resolve(__dirname, 'fixtures/display-user.js');
		const result = await buildFiles(entryPoint);

		const transformedCode = result.outputFiles[0].text;

		// Extract the updateUserStatus function body
		const functionMatch = transformedCode.match(
			/function updateUserStatus\(userId,\s*action\)\s*\{([\s\S]*?)\n\}/
		);
		expect(functionMatch).toBeTruthy();
		const functionBody = functionMatch![1];

		// The original @inline function call should not appear
		expect(functionBody).not.toContain('logUserActivity(');

		// The inlined function body should be present
		expect(functionBody).toContain('userCache.get(userId)');
		expect(functionBody).toContain('console.log');
		expect(functionBody).toContain('performed:');

		// Control flow should be preserved
		expect(functionBody).toContain('if (!');
		expect(functionBody).toContain('return');
	});
});
