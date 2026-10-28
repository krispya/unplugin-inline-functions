import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/vite.ts',
		'src/webpack.ts',
		'src/rollup.ts',
		'src/esbuild.ts',
		'src/rolldown.ts',
	],
	format: ['esm', 'cjs'],
	platform: 'node',
	target: 'esnext',
	deps: {
		onlyBundle: ['chalk'],
		neverBundle: [
			'@babel/generator',
			'@babel/parser',
			'@babel/traverse',
			'@babel/types',
			'unplugin',
			'fast-glob',
		],
		dts: {
			neverBundle: true,
		},
	},
	outExtensions: ({ format }) => ({
		js: format === 'cjs' ? '.cjs' : '.js',
		dts: format === 'cjs' ? '.d.cts' : '.d.ts',
	}),
	cjsDefault: false,
	dts: {
		generator: 'tsgo',
	},
	clean: true,
});
