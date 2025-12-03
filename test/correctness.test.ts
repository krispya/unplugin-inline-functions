import { describe, expect, it } from 'vitest';
import { buildFilesEsbuild } from './utils/build-esbuild';
import { resolve } from 'path';

describe('Correctness tests', () => {
	it('should handle missing arguments gracefully when inlining', async () => {
		// This test expects the transformation to succeed and inline the function
		// Currently it will fail because the bug causes an error during transformation
		// After fixing the bug, this test should pass
		const entryPoint = resolve(__dirname, 'fixtures/missing-args.js');

		const result = await buildFilesEsbuild(entryPoint);
		const transformedCode = result.outputFiles[0].text;

		expect(transformedCode).not.toContain('processData(10, 20)');

		// The inlined function body should appear instead
		expect(transformedCode).toContain('const sum =');
		expect(transformedCode).toContain('const product =');
	});

	it('should preserve statements after if statements when inlining', async () => {
		const entryPoint = resolve(__dirname, 'fixtures/if-statement-followed-by-assignment.js');
		const result = await buildFilesEsbuild(entryPoint);
		const transformedCode = result.outputFiles[0].text;

		// Verify the function call was inlined
		expect(transformedCode).not.toMatch(/setArrayValue\s*\(array,\s*5,\s*testValue\)/);

		// Extract the testSetArrayValue function body
		const functionMatch = transformedCode.match(
			/function testSetArrayValue\(\)\s*\{([\s\S]*?)\n\}/
		);
		expect(functionMatch).toBeTruthy();
		const functionBody = functionMatch![1];

		// Verify the assignment exists
		expect(functionBody).toMatch(/array\[[\s\S]*?\]\s*=\s*testValue/);

		// Verify the assignment is NOT in an else block
		// Should NOT match: } else { ... array[...] = testValue ... }
		const assignmentInElsePattern = /\}\s*else\s*\{[\s\S]*?array\[[\s\S]*?\]\s*=\s*testValue/;
		expect(functionBody).not.toMatch(assignmentInElsePattern);
	});

	it('should preserve early exit semantics when inlining functions with early returns', async () => {
		const entryPoint = resolve(__dirname, 'fixtures/early-exit-return.js');
		const result = await buildFilesEsbuild(entryPoint);
		const transformedCode = result.outputFiles[0].text;

		// Verify the function call was inlined
		expect(transformedCode).not.toMatch(/processIfPositive\s*\(-5,\s*output\)/);

		// Extract the testEarlyExit function body
		const functionMatch = transformedCode.match(/function testEarlyExit\(\)\s*\{([\s\S]*?)\n\}/);
		expect(functionMatch).toBeTruthy();
		const functionBody = functionMatch![1];

		// Verify the processing code exists
		expect(functionBody).toMatch(/output\.value\s*=\s*[\d-]+\s*\*\s*2/);

		// Verify the processing code IS in an else block (to preserve early exit)
		// Should match: } else { ... output.value = ... ... }
		const processingInElsePattern = /\}\s*else\s*\{[\s\S]*?output\.value\s*=\s*[\d-]+\s*\*\s*2/;
		expect(functionBody).toMatch(processingInElsePattern);
	});

	it.only('should preserve control flow when inlining multiple functions in conditional branches', async () => {
		const entryPoint = resolve(__dirname, 'fixtures/conditional-inline-bug.js');
		const result = await buildFilesEsbuild(entryPoint);
		const transformedCode = result.outputFiles[0].text;

		console.log(transformedCode);

		// Extract the processValue function body
		const functionMatch = transformedCode.match(
			/function processValue\(value\)\s*\{([\s\S]*?)\n\}/
		);
		expect(functionMatch).toBeTruthy();
		const functionBody = functionMatch![1];

		// Both function calls should be inlined (not appear as function calls)
		expect(functionBody).not.toContain('processTypeA(');
		expect(functionBody).not.toContain('processTypeB(');

		// The condition check should come FIRST, before any inlined code from processTypeA
		const ifIndex = functionBody.indexOf('if (checkCondition(value');
		// Variables are renamed with suffixes like _0_$f, but still contain the base name
		const ctxAIndex = functionBody.search(/ctxA/);
		const ctxBIndex = functionBody.search(/ctxB/);

		expect(ifIndex).toBeGreaterThanOrEqual(0);
		expect(ctxAIndex).toBeGreaterThanOrEqual(0);

		// The if statement should come BEFORE the ctxA code
		expect(ifIndex, 'ctxA should be inside the if block, not before it').toBeLessThan(ctxAIndex);

		// ctxB should exist in the else branch
		if (ctxBIndex >= 0) {
			// If ctxB exists, verify it's after the if block
			expect(ctxBIndex).toBeGreaterThan(ifIndex);
		}

		// Verify the correct structure: if (condition) { ... ctxA code ... } else { ... ctxB code ... }
		// The pattern ensures ctxA is inside the if block and ctxB is in the else block
		const correctPattern =
			/if\s*\(checkCondition\(value\)\)\s*\{[\s\S]*?ctxA[\s\S]*?\}[\s\S]*?ctxB/;

		expect(functionBody).toMatch(correctPattern);
	});
});
