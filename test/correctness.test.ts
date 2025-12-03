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
});
