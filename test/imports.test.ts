import { describe, expect, it } from 'vitest';
import { buildFilesEsbuild } from './utils/build-esbuild';
import { resolve } from 'path';

// These tests verify that relative imports are correctly rewritten when inlining.
// Import path correctness is enforced by esbuild's resolver - if the plugin generates
// a wrong path (e.g., "./symbols" instead of "./subdir-barrel/relation/symbols"),
// esbuild throws "Could not resolve" and the test fails before assertions run.
describe('import path rewriting', () => {
	it('should rewrite imports when inlining via barrel re-exports', async () => {
		// subdir-consumer.ts → subdir-barrel/index.ts → relation/relation.ts → ./symbols
		const entryPoint = resolve(__dirname, 'fixtures/subdir-consumer.ts');
		const result = await buildFilesEsbuild(entryPoint);
		const code = result.outputFiles[0].text;

		expect(code).not.toMatch(/createRelation\s*\(/);
		expect(code).toMatch(/\[\s*\$relation\s*\]/);
	});

	it('should rewrite imports when consumer is in a subdirectory', async () => {
		// nested/deep-consumer.ts → ../subdir-barrel → relation/relation.ts → ./symbols
		const entryPoint = resolve(__dirname, 'fixtures/nested/deep-consumer.ts');
		const result = await buildFilesEsbuild(entryPoint);
		const code = result.outputFiles[0].text;

		expect(code).not.toMatch(/createRelation\s*\(/);
		expect(code).toMatch(/\[\s*\$relation\s*\]/);
	});

	it('should rewrite multiple dependencies from inlined function', async () => {
		// multi-dep-consumer.ts → subdir-barrel → tagged/tagged.ts → ./symbols + ./validate
		const entryPoint = resolve(__dirname, 'fixtures/multi-dep-consumer.ts');
		const result = await buildFilesEsbuild(entryPoint);
		const code = result.outputFiles[0].text;

		expect(code).not.toMatch(/createTagged\s*\(/);
		expect(code).toMatch(/\[\s*\$tag\s*\]/);
		expect(code).toMatch(/validateTag\s*\(/);
	});

	it('should rewrite imports when consumer is sibling to symbols directory', async () => {
		// src-style/consumer.ts → ./utils/is-thing.ts → ../symbols.ts
		// If path was wrong (./utils/is-thing instead of ./symbols), build fails with:
		// "No matching export in 'utils/is-thing.ts' for import '$mySymbol'"
		const entryPoint = resolve(__dirname, 'fixtures/src-style/consumer.ts');
		const result = await buildFilesEsbuild(entryPoint);
		const code = result.outputFiles[0].text;

		expect(code).not.toMatch(/isThing\s*\(/);
		expect(code).toMatch(/\[\s*\$mySymbol\s*\]/);
	});

	it('should handle nested @inline functions with dependencies', async () => {
		// Nested inlining: consumer → outer (@inline) → inner (@inline)
		// inner imports $marker from ./symbols
		// Bug: when resolving inner's dependencies, plugin must use inner's path, not outer's
		const entryPoint = resolve(__dirname, 'fixtures/nested-inline/consumer.ts');
		const result = await buildFilesEsbuild(entryPoint);
		const code = result.outputFiles[0].text;

		// Outer function should be inlined (not called)
		expect(code).not.toMatch(/findMarked\s*\(\s*items\s*\)/);
		// Build succeeding proves the plugin generated correct import path (./symbols)
		// If wrong path was generated (./inner), esbuild would fail with:
		// "No matching export in 'inner.ts' for import '$marker'"
		expect(code).toMatch(/\[\s*\$marker\s*\]/);
	});
});
