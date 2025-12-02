import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import { buildFilesEsbuild } from './utils/build-esbuild';
import { buildFilesWithRollup } from './utils/build-rollup';
import { buildFilesWithVite } from './utils/build-vite';

const bundlers = [
	{ name: 'esbuild', buildFn: buildFilesEsbuild },
	{ name: 'rollup', buildFn: buildFilesWithRollup },
	{ name: 'vite', buildFn: buildFilesWithVite },
];

// Common test logic
function assertInlinedFunctions(transformedCode: string) {
	// Extract the displayUserInfo function body
	const functionMatch = transformedCode.match(
		/function displayUserInfo\(userId\)\s*\{([\s\S]*?)\n\}/
	);
	expect(functionMatch, 'displayUserInfo function should exist').toBeTruthy();
	const functionBody = functionMatch![1];

	// The original @inline function calls should not appear in the function body
	expect(functionBody).not.toContain('getUser(');
	expect(functionBody).not.toContain('getUserName(');

	// Instead, the function bodies should be inlined directly
	expect(functionBody).toContain('userCache.get(');
	expect(functionBody).toContain('database.users.find(');
	// Optional chaining might be transformed by bundlers, so check for either format
	expect(functionBody.includes('?.name') || functionBody.includes('_a.name')).toBeTruthy();
	expect(functionBody).toContain('"Unknown"');
}

describe('Multi-bundler support', () => {
	for (const { name, buildFn } of bundlers) {
		describe(`${name} bundler`, () => {
			it('should inline functions marked with @inline decorator', async () => {
				const entryPoint = resolve(__dirname, 'fixtures/display-user.ts');
				const result = await buildFn(entryPoint);
				const transformedCode = result.outputFiles[0].text;

				assertInlinedFunctions(transformedCode);
			});

			it('should handle pure functions correctly', async () => {
				const fixtureFile = resolve(__dirname, 'fixtures/pure-functions.ts');
				const result = await buildFn(fixtureFile);
				const transformedCode = result.outputFiles[0].text;

				// Functions with @pure should have the pure flag before their calls
				expect(transformedCode).toContain('/* @__PURE__ */ add(5, 3)');
				expect(transformedCode).toContain('/* @__PURE__ */ multiply(sum, 2)');

				// Regular functions should not have the pure flag
				expect(transformedCode).not.toContain('/* @__PURE__ */ log(');
			});
		});
	}
});
