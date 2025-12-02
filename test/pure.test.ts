import { describe, expect, it } from 'vitest';
import { buildFilesEsbuild } from './utils/build-esbuild';
import { resolve } from 'path';

describe('@pure functionality', () => {
	it('should add #__PURE__ flag to function calls for @pure decorated functions', async () => {
		// Build the fixture file containing pure functions
		const fixtureFile = resolve(__dirname, 'fixtures/pure-functions.js');
		const result = await buildFilesEsbuild(fixtureFile);

		const transformedCode = result.outputFiles[0].text;

		// Functions with @pure should have the pure flag before their calls
		// Note: Standard is #__PURE__ but Babel seems to output @__PURE__
		expect(transformedCode).toContain('/* @__PURE__ */ add(5, 3)');
		expect(transformedCode).toContain('/* @__PURE__ */ multiply(sum, 2)');

		// Regular functions should not have the pure flag
		expect(transformedCode).not.toContain('/* @__PURE__ */ log(');
	});
});
