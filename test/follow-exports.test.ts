import * as esbuild from 'esbuild';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import inlineFunctions from '../src/esbuild';

describe('followExports option', () => {
	it('should automatically discover files via export * from when followExports is true (default)', async () => {
		// Create a temporary project structure
		const tempProjectDir = fs.mkdtempSync(path.join(tmpdir(), 'follow-exports-test-'));
		const srcDir = path.join(tempProjectDir, 'src');
		const libDir = path.join(tempProjectDir, 'lib');
		fs.mkdirSync(srcDir, { recursive: true });
		fs.mkdirSync(libDir, { recursive: true });

		// Create lib file with @inline function
		const libFile = path.join(libDir, 'utils.ts');
		fs.writeFileSync(
			libFile,
			`export /* @inline */ function helper(x: number) {
	return x * 2;
}`
		);

		// Create src file that exports from lib
		const srcFile = path.join(srcDir, 'index.ts');
		fs.writeFileSync(
			srcFile,
			`export * from '../lib/utils';
export function calculate(value: number) {
	return helper(value);
}`
		);

		try {
			// Build with followExports enabled (default)
			const result = await esbuild.build({
				entryPoints: [srcFile],
				bundle: true,
				write: false,
				format: 'esm',
				plugins: [
					inlineFunctions({
						include: ['src/**/*.{js,ts}'],
						cwd: tempProjectDir,
						debug: false,
						followExports: true, // Explicitly enable
					}),
				],
			});

			const code = result.outputFiles[0].text;

			// The helper function should be inlined (not called in calculate function)
			// Check that calculate function body contains the inlined code, not a function call
			const calculateMatch = code.match(/function calculate\([^)]*\)\s*\{([\s\S]*?)\n\}/);
			expect(calculateMatch).toBeTruthy();
			const calculateBody = calculateMatch![1];
			expect(calculateBody).not.toContain('helper(');
			expect(calculateBody).toContain('* 2'); // The inlined body
		} finally {
			fs.rmSync(tempProjectDir, { recursive: true, force: true });
		}
	});

	it('should NOT discover files via export * from when followExports is false', async () => {
		// Create a temporary project structure
		const tempProjectDir = fs.mkdtempSync(path.join(tmpdir(), 'follow-exports-test-'));
		const srcDir = path.join(tempProjectDir, 'src');
		const libDir = path.join(tempProjectDir, 'lib');
		fs.mkdirSync(srcDir, { recursive: true });
		fs.mkdirSync(libDir, { recursive: true });

		// Create lib file with @inline function
		const libFile = path.join(libDir, 'utils.ts');
		fs.writeFileSync(
			libFile,
			`export /* @inline */ function helper(x: number) {
	return x * 2;
}`
		);

		// Create src file that exports from lib
		const srcFile = path.join(srcDir, 'index.ts');
		fs.writeFileSync(
			srcFile,
			`export * from '../lib/utils';
export function calculate(value: number) {
	return helper(value);
}`
		);

		try {
			// Build with followExports disabled
			const result = await esbuild.build({
				entryPoints: [srcFile],
				bundle: true,
				write: false,
				format: 'esm',
				plugins: [
					inlineFunctions({
						include: ['src/**/*.{js,ts}'],
						cwd: tempProjectDir,
						debug: false,
						followExports: false, // Disable
					}),
				],
			});

			const code = result.outputFiles[0].text;

			// The helper function should NOT be inlined because lib/utils.ts wasn't scanned
			// It should still be called as a function
			expect(code).toContain('helper(');
		} finally {
			fs.rmSync(tempProjectDir, { recursive: true, force: true });
		}
	});

	it('should handle export { ... } from statements', async () => {
		const tempProjectDir = fs.mkdtempSync(path.join(tmpdir(), 'follow-exports-test-'));
		const srcDir = path.join(tempProjectDir, 'src');
		const libDir = path.join(tempProjectDir, 'lib');
		fs.mkdirSync(srcDir, { recursive: true });
		fs.mkdirSync(libDir, { recursive: true });

		const libFile = path.join(libDir, 'utils.ts');
		fs.writeFileSync(
			libFile,
			`export /* @inline */ function helper(x: number) {
	return x * 2;
}`
		);

		const srcFile = path.join(srcDir, 'index.ts');
		fs.writeFileSync(
			srcFile,
			`export { helper } from '../lib/utils';
export function calculate(value: number) {
	return helper(value);
}`
		);

		try {
			const result = await esbuild.build({
				entryPoints: [srcFile],
				bundle: true,
				write: false,
				format: 'esm',
				plugins: [
					inlineFunctions({
						include: ['src/**/*.{js,ts}'],
						cwd: tempProjectDir,
						followExports: true,
					}),
				],
			});

			const code = result.outputFiles[0].text;
			// Check that calculate function body contains the inlined code
			const calculateMatch = code.match(/function calculate\([^)]*\)\s*\{([\s\S]*?)\n\}/);
			expect(calculateMatch).toBeTruthy();
			const calculateBody = calculateMatch![1];
			expect(calculateBody).not.toContain('helper(');
			expect(calculateBody).toContain('* 2');
		} finally {
			fs.rmSync(tempProjectDir, { recursive: true, force: true });
		}
	});
});
