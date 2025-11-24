import { build } from 'vite';
import inlineFunctions from '../../src/vite';
import path from 'path';
import fs from 'fs';

export async function buildFilesWithVite(entryPoint: string) {
	const result = await build({
		root: path.resolve(__dirname, '../..'),
		build: {
			write: false,
			minify: false, // Don't minify for testing
			lib: {
				entry: path.resolve(entryPoint), // Use absolute path
				formats: ['es'],
			},
			rollupOptions: {
				output: {
					entryFileNames: '[name].js',
				},
			},
		},
		plugins: [
			inlineFunctions({
				include: ['test/fixtures/**/*.{js,ts}'],
				cwd: path.resolve(__dirname, '../..'),
			}),
		],
		logLevel: 'error',
	});

	// Vite returns an array or single output
	const output = Array.isArray(result) ? result[0] : result;

	// Return in esbuild-compatible format
	return {
		outputFiles: [
			{
				text: 'output' in output ? output.output[0].code : '',
				path: entryPoint,
			},
		],
	};
}

export async function buildWithVite(code: string) {
	// Create a temporary file for stdin-like behavior
	const tempFile = path.resolve(__dirname, '../fixtures/.temp-test-vite.js');
	fs.writeFileSync(tempFile, code);

	try {
		const result = await buildFilesWithVite(tempFile);
		return result;
	} finally {
		// Clean up temp file
		if (fs.existsSync(tempFile)) {
			fs.unlinkSync(tempFile);
		}
	}
}
