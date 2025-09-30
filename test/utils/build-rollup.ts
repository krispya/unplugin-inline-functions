import { rollup } from 'rollup';
import inlineFunctions from '../../src/rollup';
import esbuild from 'rollup-plugin-esbuild';
import path from 'path';
import fs from 'fs';

export async function buildFilesWithRollup(entryPoint: string) {
	const bundle = await rollup({
		input: path.resolve(entryPoint), // Use absolute path
		plugins: [
			inlineFunctions({
				include: ['test/fixtures/**/*.{js,ts}'],
				cwd: path.resolve(__dirname, '../..'),
			}),
			esbuild({
				target: 'esnext',
				minify: false,
			}),
		],
		external: [], // Don't externalize anything
	});

	const { output } = await bundle.generate({
		format: 'esm',
		name: 'testBundle',
	});

	await bundle.close();

	// Return in esbuild-compatible format
	return {
		outputFiles: [
			{
				text: output[0].code,
				path: entryPoint,
			},
		],
	};
}

export async function buildWithRollup(code: string) {
	// Create a temporary file for stdin-like behavior
	const tempFile = path.resolve(__dirname, '../fixtures/.temp-test.js');
	fs.writeFileSync(tempFile, code);

	try {
		const result = await buildFilesWithRollup(tempFile);
		return result;
	} finally {
		// Clean up temp file
		if (fs.existsSync(tempFile)) {
			fs.unlinkSync(tempFile);
		}
	}
}
