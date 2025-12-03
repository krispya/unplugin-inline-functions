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
});
