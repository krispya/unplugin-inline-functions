import { describe, expect, it } from 'vitest';
import { buildFilesEsbuild } from './utils/build-esbuild';
import { resolve } from 'path';

describe('@inline functionality', () => {
	it('should inline functions marked with @inline decorator across files', async () => {
		// Build the entry point which imports the inlinable functions
		const entryPoint = resolve(__dirname, 'fixtures/display-user.js');
		const result = await buildFilesEsbuild(entryPoint);

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
		const result = await buildFilesEsbuild(entryPoint);

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

	it('should inline functions marked with @inline @pure in return statements', async () => {
		// Build the entry point which imports the inlinable functions
		const entryPoint = resolve(__dirname, 'fixtures/inline-with-pure-functions.js');
		const result = await buildFilesEsbuild(entryPoint);

		const transformedCode = result.outputFiles[0].text;

		// Extract the inlineInReturnStatement function body
		const functionMatch = transformedCode.match(
			/function inlineInReturnStatement\(seed\)\s*\{([\s\S]*?)\n\}/
		);
		expect(functionMatch).toBeTruthy();
		const functionBody = functionMatch![1];

		// The original @inline function call should not appear
		expect(functionBody).not.toContain('addOneToGeneratedNumber(');

		// One invocation keeps one random read inside its expression context.
		expect(functionBody.match(/generateNumber\(\)/g)).toHaveLength(1);
		expect(functionBody).toContain('return multiply(');
		// The unannotated multiply binding must not inherit purity from another file.
		expect(functionBody).not.toMatch(/@__PURE__[^\n]*multiply\(/);
	});

	it('should inline functions marked with @inline @pure in if statements with separate variable declarations', async () => {
		// Build the entry point which imports the inlinable functions
		const entryPoint = resolve(__dirname, 'fixtures/inline-with-pure-functions.js');
		const result = await buildFilesEsbuild(entryPoint);

		const transformedCode = result.outputFiles[0].text;

		// Extract the inlineWithIfStatement function body
		const functionMatch = transformedCode.match(
			/function inlineWithIfStatement\(seed\)\s*\{([\s\S]*?)\n\}/
		);
		expect(functionMatch).toBeTruthy();
		const functionBody = functionMatch![1];

		// The original @inline function call should not appear
		expect(functionBody).not.toContain('addOneToGeneratedNumber(');

		expect(functionBody).toMatch(/if\s*\(\s*seed\s*>\s*0\s*\)\s*\{/);
		// Each branch has its own invocation and its own random read.
		expect(functionBody.match(/generateNumber\(\)/g)).toHaveLength(2);
		expect(functionBody).toContain('return multiply(');
	});
});
