import * as esbuild from 'esbuild';
import unplugin from '../../src/esbuild';
import path from 'path';

export async function build(code: string) {
	return await esbuild.build({
		stdin: {
			contents: code,
			loader: 'js',
		},
		bundle: false,
		write: false,
		format: 'esm',
		plugins: [
			unplugin({
				include: ['test/fixtures/**/*.{js,ts}'],
				cwd: path.resolve(__dirname, '../..'),
			}),
		],
	});
}
