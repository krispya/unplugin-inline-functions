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

		// Verify the exact structure:
		// 1. const result_0_$f = generateNumber(); should appear before the return
		expect(functionBody).toMatch(/const result_0_\$f = generateNumber\(\);/);

		// 2. /* @__PURE__ */ should appear before multiply in the return statement
		expect(functionBody).toMatch(/return\s+\/\*\s*@__PURE__\s*\*\/\s*multiply\(/);

		// 3. result_0_$f + seed should be inside the multiply call
		expect(functionBody).toMatch(/multiply\(result_0_\$f\s+\+\s+seed/);
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

		// Verify the exact structure:
		// 1. If block should have its own variable declaration
		expect(functionBody).toMatch(/if\s*\(\s*seed\s*>\s*0\s*\)\s*\{/);
		expect(functionBody).toMatch(/const result_1_\$f = generateNumber\(\);/);
		expect(functionBody).toMatch(/return result_1_\$f\s+\+\s+seed;/);

		// 2. After the if block, there should be a separate variable declaration for the second call
		expect(functionBody).toMatch(/const result_2_\$f = generateNumber\(\);/);

		// 3. /* @__PURE__ */ should appear before multiply in the return statement
		expect(functionBody).toMatch(/return\s+\/\*\s*@__PURE__\s*\*\/\s*multiply\(/);

		// 4. result_2_$f + seed should be inside the multiply call
		expect(functionBody).toMatch(/multiply\(result_2_\$f\s+\+\s+seed/);
	});
});
