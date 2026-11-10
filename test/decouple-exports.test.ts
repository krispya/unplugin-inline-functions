import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rollup } from 'rollup';
import { expect, it } from 'vitest';
import inlineFunctions from '../src/rollup';

/** Bundle the given entries into ES module chunks on disk and return them with a loader. */
async function bundle(
	files: Record<string, string>,
	entries: string[],
	options: Record<string, unknown> = {},
	output: { sourcemap?: boolean; preserveModules?: boolean } = {}
) {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'inline-exports-')));
	for (const [name, source] of Object.entries(files))
		fs.writeFileSync(path.join(directory, name), source);
	const build = await rollup({
		input: entries.map((entry) => path.join(directory, entry)),
		plugins: [inlineFunctions({ cwd: directory, include: ['*.js'], ...options })],
	});
	const { output: written } = await build.write({
		dir: path.join(directory, 'out'),
		format: 'es',
		...output,
	});
	await build.close();
	const chunks = written.flatMap((chunk) => (chunk.type === 'chunk' ? [chunk] : []));
	return {
		chunks,
		shared: chunks.find((chunk) => !chunk.isEntry),
		load: (entry: string) => import(pathToFileURL(path.join(directory, 'out', entry)).href),
		remove: () => fs.rmSync(directory, { recursive: true, force: true }),
	};
}

const library = {
	'shared.js':
		"export const key = Symbol('key'); export let count = 0; export function bump() { count++; } export function read(object) { return object[key]; }",
	'a.js': "import {key, bump, count, read} from './shared.js'; export function run() { bump(); bump(); return [typeof key, count, read({[key]: 7})]; }",
	'b.js': "import {key, read} from './shared.js'; export function tag(object) { object[key] = 1; return read(object); }",
};

it('exports aliases of bindings that never change and keeps the rest live', async () => {
	const result = await bundle(library, ['a.js', 'b.js']);
	try {
		const code = result.shared!.code;
		expect(code).toMatch(/const (\w+\$export) = key;/);
		expect(code).toMatch(/const (\w+\$export) = read;/);
		expect(code).toMatch(/export \{[^}]*\bcount\b(?! as \w+\$export)/);
		expect(code).not.toMatch(/\$export = count;/);
		const a = await result.load('a.js');
		const b = await result.load('b.js');
		expect(a.run()).toEqual(['symbol', 2, 7]);
		expect(b.tag({})).toBe(1);
	} finally {
		result.remove();
	}
});

it('leaves exports alone when the option is off', async () => {
	const result = await bundle(library, ['a.js', 'b.js'], { decoupleExports: false });
	try {
		expect(result.shared!.code).not.toContain('$export');
		expect((await result.load('a.js')).run()).toEqual(['symbol', 2, 7]);
	} finally {
		result.remove();
	}
});

it('skips chunks that import one another', async () => {
	// Kept as separate chunks, the two modules form a cycle that reads an export early.
	const result = await bundle(
		{
			'a.js': "import {b} from './b.js'; export const a = () => 'a'; export function run() { return a() + b(); }",
			'b.js': "import {a} from './a.js'; export const b = () => 'b' + typeof a;",
		},
		['a.js', 'b.js'],
		{},
		{ preserveModules: true }
	);
	try {
		expect(result.chunks).toHaveLength(2);
		for (const chunk of result.chunks) expect(chunk.code).not.toContain('$export');
		expect((await result.load('a.js')).run()).toBe('abfunction');
	} finally {
		result.remove();
	}
});

it('maps the rewritten chunk when source maps are on', async () => {
	const result = await bundle(library, ['a.js', 'b.js'], {}, { sourcemap: true });
	try {
		expect(result.shared!.code).toContain('$export');
		expect(result.shared!.map?.mappings.length).toBeGreaterThan(0);
		expect((await result.load('a.js')).run()).toEqual(['symbol', 2, 7]);
	} finally {
		result.remove();
	}
});
