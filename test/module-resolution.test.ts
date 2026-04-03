import * as esbuild from 'esbuild';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import inlineFunctions from '../src/esbuild';

describe('module resolution', () => {
	it('does not follow local workspace package imports by default', async () => {
		const tempProjectDir = fs.mkdtempSync(path.join(tmpdir(), 'follow-package-imports-'));
		const appDir = path.join(tempProjectDir, 'packages/app');
		const libDir = path.join(tempProjectDir, 'packages/lib');
		const appSrcDir = path.join(appDir, 'src');
		const libSrcDir = path.join(libDir, 'src');
		const nodeModulesDir = path.join(tempProjectDir, 'node_modules/@scope/lib');

		fs.mkdirSync(appSrcDir, { recursive: true });
		fs.mkdirSync(libSrcDir, { recursive: true });
		fs.mkdirSync(nodeModulesDir, { recursive: true });

		fs.writeFileSync(path.join(tempProjectDir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
		fs.writeFileSync(path.join(tempProjectDir, 'package.json'), JSON.stringify({ private: true }));
		fs.writeFileSync(
			path.join(appDir, 'package.json'),
			JSON.stringify({ name: 'app', private: true, type: 'module' })
		);
		fs.writeFileSync(
			path.join(libDir, 'package.json'),
			JSON.stringify({
				name: '@scope/lib',
				private: true,
				type: 'module',
				main: './src/index.ts',
			})
		);
		fs.writeFileSync(
			path.join(nodeModulesDir, 'package.json'),
			JSON.stringify({
				name: '@scope/lib',
				private: true,
				type: 'module',
				main: '../../../packages/lib/src/index.ts',
			})
		);
		fs.writeFileSync(
			path.join(libSrcDir, 'index.ts'),
			`export /* @inline */ function helper(value: number) {
	return value * 2;
}`
		);
		fs.writeFileSync(
			path.join(appSrcDir, 'index.ts'),
			`import { helper } from '@scope/lib';

export function calculate(value: number) {
	return helper(value);
}`
		);

		try {
			const defaultResult = await esbuild.build({
				entryPoints: [path.join(appSrcDir, 'index.ts')],
				bundle: true,
				write: false,
				format: 'esm',
				plugins: [
					inlineFunctions({
						include: ['src/**/*.{js,ts}'],
						cwd: appDir,
						followImports: 'all',
					}),
				],
			});

			const defaultCode = defaultResult.outputFiles[0].text;
			expect(defaultCode).toContain('helper(');

			const enabledResult = await esbuild.build({
				entryPoints: [path.join(appSrcDir, 'index.ts')],
				bundle: true,
				write: false,
				format: 'esm',
				plugins: [
					inlineFunctions({
						include: ['src/**/*.{js,ts}'],
						cwd: appDir,
						followImports: 'all',
						followPackageImports: 'workspace',
					}),
				],
			});

			const enabledCode = enabledResult.outputFiles[0].text;
			expect(enabledCode).not.toContain('helper(');
			expect(enabledCode).toContain('* 2');
		} finally {
			fs.rmSync(tempProjectDir, { recursive: true, force: true });
		}
	});

	it('resolves alias imports for discovery and injected dependencies', async () => {
		const tempProjectDir = fs.mkdtempSync(path.join(tmpdir(), 'alias-imports-'));
		const srcDir = path.join(tempProjectDir, 'src');

		fs.mkdirSync(srcDir, { recursive: true });
		fs.writeFileSync(path.join(tempProjectDir, 'package.json'), JSON.stringify({ private: true }));
		fs.writeFileSync(path.join(srcDir, 'symbols.ts'), `export const marker = Symbol('marker');`);
		fs.writeFileSync(
			path.join(srcDir, 'utils.ts'),
			`import { marker } from '@/symbols';

export /* @inline */ function hasMarker(value: { marker: symbol }) {
	return value.marker === marker;
}`
		);
		fs.writeFileSync(
			path.join(srcDir, 'index.ts'),
			`import { hasMarker } from '@/utils';

export function check(value: { marker: symbol }) {
	return hasMarker(value);
}`
		);

		try {
			const result = await esbuild.build({
				entryPoints: [path.join(srcDir, 'index.ts')],
				bundle: true,
				write: false,
				format: 'esm',
				plugins: [
					{
						name: 'alias-test-resolver',
						setup(build) {
							build.onResolve({ filter: /^@\// }, (args) => ({
								path: path.join(srcDir, args.path.slice(2)),
							}));
						},
					},
					inlineFunctions({
						include: ['src/**/*.{js,ts}'],
						cwd: tempProjectDir,
						followImports: 'all',
						alias: {
							'@': './src',
						},
					}),
				],
				resolveExtensions: ['.js', '.ts'],
			});

			const code = result.outputFiles[0].text;
			expect(code).not.toContain('hasMarker(');
			expect(code).toContain('Symbol("marker")');
			expect(code).toContain('value.marker === marker');
		} finally {
			fs.rmSync(tempProjectDir, { recursive: true, force: true });
		}
	});
});
