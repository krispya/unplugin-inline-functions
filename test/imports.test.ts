import { describe, expect, it } from 'vitest';
import { buildFilesEsbuild } from './utils/build-esbuild';
import { resolve } from 'path';

// These tests verify that relative imports are correctly rewritten when inlining.
// Import path correctness is enforced by esbuild's resolver - if the plugin generates
// a wrong path (e.g., "./symbols" instead of "./subdir-barrel/relation/symbols"),
// esbuild throws "Could not resolve" and the test fails before assertions run.
describe('import path rewriting', () => {
	it('should rewrite relative imports when inlining via barrel re-exports', async () => {
		const entryPoint = resolve(__dirname, 'fixtures/subdir-consumer.ts');
		const result = await buildFilesEsbuild(entryPoint);
		const code = result.outputFiles[0].text;

		expect(code).not.toMatch(/createRelation\s*\(/);
		expect(code).toContain('$relation');
	});

	it('should rewrite imports when consumer is in a subdirectory', async () => {
		const entryPoint = resolve(__dirname, 'fixtures/nested/deep-consumer.ts');
		const result = await buildFilesEsbuild(entryPoint);
		const code = result.outputFiles[0].text;

		expect(code).not.toMatch(/createRelation\s*\(/);
		expect(code).toContain('$relation');
	});

	it('should rewrite multiple dependencies from inlined function', async () => {
		const entryPoint = resolve(__dirname, 'fixtures/multi-dep-consumer.ts');
		const result = await buildFilesEsbuild(entryPoint);
		const code = result.outputFiles[0].text;

		expect(code).not.toMatch(/createTagged\s*\(/);
		expect(code).toContain('$tag');
		expect(code).toContain('validateTag');
	});
});
