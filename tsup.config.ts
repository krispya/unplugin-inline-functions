import { defineConfig } from 'tsup';

export default defineConfig({
	entry: ['src/index.ts', 'src/vite.ts', 'src/webpack.ts', 'src/rollup.ts', 'src/esbuild.ts'],
	format: ['esm', 'cjs'],
	external: [
		'node:fs',
		'node:crypto',
		'node:path',
		'tty',
		'util',
		'os',
		'@babel/generator',
		'@babel/parser',
		'@babel/traverse',
		'@babel/types',
		'unplugin',
		'fast-glob',
	],
	dts: true,
	clean: true,
});
