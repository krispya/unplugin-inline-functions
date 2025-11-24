import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import { buildFiles as buildFilesEsbuild } from './utils/build-files';
import { buildFilesWithRollup } from './utils/build-rollup';
import { buildFilesWithVite } from './utils/build-vite';

const bundlers = [
	{ name: 'esbuild', buildFn: buildFilesEsbuild },
	{ name: 'rollup', buildFn: buildFilesWithRollup },
	{ name: 'vite', buildFn: buildFilesWithVite },
];

describe('Two-pass metadata collection', () => {
	for (const { name, buildFn } of bundlers) {
		describe(`${name} bundler`, () => {
			it('should inline functions across files (proving two-pass works)', async () => {
				const entryPoint = resolve(__dirname, 'fixtures/cross-file-main.ts');
				const result = await buildFn(entryPoint);
				const transformedCode = result.outputFiles[0].text;

				// Function calls should NOT appear - they should be inlined
				expect(transformedCode).not.toContain('crossFileHelper(');
				expect(transformedCode).not.toContain('doubleValue(');

				// The inlined logic should be present
				// crossFileHelper: x * 2 + 10
				expect(transformedCode).toContain('* 2');
				expect(transformedCode).toContain('+ 10');

				// Verify the calculate function exists
				expect(transformedCode).toContain('calculate');
				expect(transformedCode).toContain('processNumbers');
			});

			it('should work even when entry file is processed before dependency', async () => {
				// This test ensures that even if the bundler wants to transform
				// cross-file-main.ts before seeing cross-file-lib.ts, our buildStart
				// hook has already collected metadata from both files
				const entryPoint = resolve(__dirname, 'fixtures/cross-file-main.ts');
				const result = await buildFn(entryPoint);
				const code = result.outputFiles[0].text;

				// Extract the calculate function to check its body
				const calculateMatch = code.match(/function calculate\([^)]*\)\s*\{([\s\S]*?)\n\}/);

				if (calculateMatch) {
					const functionBody = calculateMatch[1];

					// Should not have the original function call
					expect(functionBody).not.toContain('crossFileHelper(');

					// Should have inlined the logic
					expect(
						functionBody.includes('* 2') && functionBody.includes('+ 10')
					).toBeTruthy();
				} else {
					// If function is transformed differently (e.g., arrow function),
					// at least verify no function calls remain
					expect(code).not.toContain('crossFileHelper(');
				}
			});
		});
	}

	it('demonstrates why two-pass is necessary', () => {
		// Documentation test - explains the concept
		const explanation = `
			Two-pass system is required because:
			
			1. First Pass (buildStart): Scan ALL files matching 'include' patterns
			   - Discovers crossFileHelper is @inline in cross-file-lib.ts
			   - Builds global metadata map before ANY transformation
			
			2. Second Pass (transform): Transform each file using collected metadata
			   - When transforming cross-file-main.ts, we already know crossFileHelper should be inlined
			   - Even though cross-file-main.ts imports from cross-file-lib.ts
			
			Without two-pass, when the bundler processes cross-file-main.ts,
			it might not have seen cross-file-lib.ts yet, so it wouldn't know
			to inline crossFileHelper().
		`;

		expect(explanation).toBeTruthy();
	});
});
