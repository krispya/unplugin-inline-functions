import * as esbuild from 'esbuild';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import inlineFunctions from '../src/esbuild';

/**
 * Test followImports option for discovering files via import statements.
 */
describe('followImports option', () => {
	it('should discover files via side-effect imports when followImports is "side-effects"', async () => {
		const tempProjectDir = fs.mkdtempSync(path.join(tmpdir(), 'follow-imports-'));
		const srcDir = path.join(tempProjectDir, 'src');
		const libDir = path.join(tempProjectDir, 'lib');

		fs.mkdirSync(srcDir, { recursive: true });
		fs.mkdirSync(libDir, { recursive: true });

		// Create a file with @inline function that's imported as side-effect
		const patchFile = path.join(libDir, 'patch.ts');
		fs.writeFileSync(
			patchFile,
			`export /* @inline */ function helper(x: number): number {
	return x * 2;
}`
		);

		// Create a file that imports the patch as side-effect
		const mainFile = path.join(srcDir, 'index.ts');
		fs.writeFileSync(
			mainFile,
			`import '../lib/patch';

export function calculate(value: number) {
	return helper(value);
}`
		);

		try {
			const result = await esbuild.build({
				entryPoints: [mainFile],
				bundle: true,
				write: false,
				format: 'esm',
				plugins: [
					inlineFunctions({
						include: ['src/**/*.{js,ts}'],
						cwd: tempProjectDir,
						debug: false,
						followExports: true,
						followImports: 'side-effects', // Only follow side-effect imports
					}),
				],
			});

			const code = result.outputFiles[0].text;

			// helper should be inlined
			expect(code).not.toContain('helper(');
			expect(code).toContain('* 2');
		} finally {
			fs.rmSync(tempProjectDir, { recursive: true, force: true });
		}
	});

	it('should NOT discover files via side-effect imports when followImports is false', async () => {
		const tempProjectDir = fs.mkdtempSync(path.join(tmpdir(), 'follow-imports-'));
		const srcDir = path.join(tempProjectDir, 'src');
		const libDir = path.join(tempProjectDir, 'lib');

		fs.mkdirSync(srcDir, { recursive: true });
		fs.mkdirSync(libDir, { recursive: true });

		const patchFile = path.join(libDir, 'patch.ts');
		fs.writeFileSync(
			patchFile,
			`export /* @inline */ function helper(x: number): number {
	return x * 2;
}`
		);

		const mainFile = path.join(srcDir, 'index.ts');
		fs.writeFileSync(
			mainFile,
			`import '../lib/patch';

export function calculate(value: number) {
	return helper(value);
}`
		);

		try {
			const result = await esbuild.build({
				entryPoints: [mainFile],
				bundle: true,
				write: false,
				format: 'esm',
				plugins: [
					inlineFunctions({
						include: ['src/**/*.{js,ts}'],
						cwd: tempProjectDir,
						debug: false,
						followExports: true,
						followImports: false, // Don't follow imports
					}),
				],
			});

			const code = result.outputFiles[0].text;

			// helper should NOT be inlined (file not discovered)
			expect(code).toContain('helper(');
		} finally {
			fs.rmSync(tempProjectDir, { recursive: true, force: true });
		}
	});

	it('should discover files via all imports when followImports is "all"', async () => {
		const tempProjectDir = fs.mkdtempSync(path.join(tmpdir(), 'follow-imports-'));
		const srcDir = path.join(tempProjectDir, 'src');
		const libDir = path.join(tempProjectDir, 'lib');

		fs.mkdirSync(srcDir, { recursive: true });
		fs.mkdirSync(libDir, { recursive: true });

		const utilsFile = path.join(libDir, 'utils.ts');
		fs.writeFileSync(
			utilsFile,
			`export /* @inline */ function helper(x: number): number {
	return x * 2;
}`
		);

		const mainFile = path.join(srcDir, 'index.ts');
		fs.writeFileSync(
			mainFile,
			`import { helper } from '../lib/utils';

export function calculate(value: number) {
	return helper(value);
}`
		);

		try {
			const result = await esbuild.build({
				entryPoints: [mainFile],
				bundle: true,
				write: false,
				format: 'esm',
				plugins: [
					inlineFunctions({
						include: ['src/**/*.{js,ts}'],
						cwd: tempProjectDir,
						debug: false,
						followExports: true,
						followImports: 'all', // Follow all imports
					}),
				],
			});

			const code = result.outputFiles[0].text;

			// helper should be inlined
			expect(code).not.toContain('helper(');
			expect(code).toContain('* 2');
		} finally {
			fs.rmSync(tempProjectDir, { recursive: true, force: true });
		}
	});

	it('should NOT discover files via named imports when followImports is "side-effects" only', async () => {
		const tempProjectDir = fs.mkdtempSync(path.join(tmpdir(), 'follow-imports-'));
		const srcDir = path.join(tempProjectDir, 'src');
		const libDir = path.join(tempProjectDir, 'lib');

		fs.mkdirSync(srcDir, { recursive: true });
		fs.mkdirSync(libDir, { recursive: true });

		const utilsFile = path.join(libDir, 'utils.ts');
		fs.writeFileSync(
			utilsFile,
			`export /* @inline */ function helper(x: number): number {
	return x * 2;
}`
		);

		const mainFile = path.join(srcDir, 'index.ts');
		fs.writeFileSync(
			mainFile,
			`import { helper } from '../lib/utils';

export function calculate(value: number) {
	return helper(value);
}`
		);

		try {
			const result = await esbuild.build({
				entryPoints: [mainFile],
				bundle: true,
				write: false,
				format: 'esm',
				plugins: [
					inlineFunctions({
						include: ['src/**/*.{js,ts}'],
						cwd: tempProjectDir,
						debug: false,
						followExports: true,
						followImports: 'side-effects', // Only side-effects, not named imports
					}),
				],
			});

			const code = result.outputFiles[0].text;

			// helper should NOT be inlined (file not discovered via named import)
			expect(code).toContain('helper(');
		} finally {
			fs.rmSync(tempProjectDir, { recursive: true, force: true });
		}
	});
});
