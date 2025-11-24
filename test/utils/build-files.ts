import * as esbuild from 'esbuild';
import unplugin from '../../src/esbuild';
import path from 'path';

export async function buildFiles(entryPoint: string) {
	return await esbuild.build({
		entryPoints: [entryPoint],
		bundle: true,
		write: false,
		format: 'esm',
		plugins: [
			unplugin({
				include: ['test/fixtures/**/*.{js,ts}'],
				cwd: path.resolve(__dirname, '../..'),
			}),
		],
		// Ensure relative imports work
		resolveExtensions: ['.js', '.ts'],
	});
}
