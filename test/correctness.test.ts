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
		const { testFunction } = await import(
			`data:text/javascript,${encodeURIComponent(transformedCode)}`
		);
		expect(testFunction()).toBe(30);
	});

	it('should preserve statements after if statements when inlining', async () => {
		const entryPoint = resolve(__dirname, 'fixtures/if-statement-followed-by-assignment.js');
		const result = await buildFilesEsbuild(entryPoint);
		const transformedCode = result.outputFiles[0].text;

		// Verify the function call was inlined
		expect(transformedCode).not.toMatch(/setArrayValue\s*\(array,\s*5,\s*testValue\)/);

		const { testSetArrayValue } = await import(
			`data:text/javascript,${encodeURIComponent(transformedCode)}`
		);
		expect(testSetArrayValue()).toBe(true);
	});

	it('should preserve early exit semantics when inlining functions with early returns', async () => {
		const entryPoint = resolve(__dirname, 'fixtures/early-exit-return.js');
		const result = await buildFilesEsbuild(entryPoint);
		const transformedCode = result.outputFiles[0].text;

		// Verify the function call was inlined
		expect(transformedCode).not.toMatch(/processIfPositive\s*\(-5,\s*output\)/);

		const { testEarlyExit } = await import(
			`data:text/javascript,${encodeURIComponent(transformedCode)}`
		);
		expect(testEarlyExit()).toBe(true);
	});

	it('should preserve control flow when inlining multiple functions in conditional branches', async () => {
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

	it('should inline calls that are the body of an unbraced if, else or loop in place', async () => {
		const entryPoint = resolve(__dirname, 'fixtures/void-call-unbraced.js');
		const result = await buildFilesEsbuild(entryPoint);
		const transformedCode = result.outputFiles[0].text;

		// The original calls must not survive next to their inlined bodies
		expect(transformedCode).not.toMatch(/(?<!function )\bbump\s*\(/);
		expect(transformedCode).not.toMatch(/(?<!function )\bscaled\s*\(/);

		// Inlined code must run as often as the call did, inside its branch or loop
		const { bumpIf, bumpElse, bumpLoop, sumScaled } = await import(
			`data:text/javascript,${encodeURIComponent(transformedCode)}`
		);
		expect(bumpIf({ value: 0 }, true)).toBe(1);
		expect(bumpIf({ value: 0 }, false)).toBe(0);
		expect(bumpElse({ value: 0 }, false)).toBe(1);
		expect(bumpElse({ value: 0 }, true)).toBe(-1);
		expect(bumpLoop({ value: 0 }, 3)).toBe(3);
		expect(sumScaled(3)).toBe(6);
	});

	it('should not rename substituted argument expressions when a local variable collides', async () => {
		const entryPoint = resolve(__dirname, 'fixtures/nested-rename-collision/index.ts');
		const result = await buildFilesEsbuild(entryPoint);
		const transformedCode = result.outputFiles[0].text;

		// Both inline calls should be inlined
		expect(transformedCode).not.toMatch(/\bprocess\s*\(/);
		expect(transformedCode).not.toMatch(/\bresolve\s*\(/);

		const { run } = await import(`data:text/javascript,${encodeURIComponent(transformedCode)}`);
		expect(run({ value: 42 }, 'value')).toBe(42);
		expect(run({ wrapped: { value: 7 } }, 'value')).toBe(7);
	});
});
