import { parse } from '@babel/parser';
import { build } from 'esbuild';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import inlineFunctions from '../src/esbuild';
import { collectMetadata, resetMetadata } from '../src/collect-metadata';
import { parseDefines } from '../src/utils/constant-folding';
import { measureBytecode, measureCacheStats, setMeasureCache } from '../src/utils/measure-bytecode';
import { setResolutionConfig } from '../src/utils/resolution-config';

async function bundle(files: Record<string, string>, options: Record<string, unknown>) {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'inline-budget-')));
	try {
		for (const [filename, source] of Object.entries(files))
			fs.writeFileSync(path.join(directory, filename), source);
		const result = await build({
			entryPoints: [path.join(directory, 'main.js')],
			bundle: true,
			write: false,
			format: 'cjs',
			platform: 'node',
			logLevel: 'silent',
			plugins: [inlineFunctions({ cwd: directory, include: ['**/*.js'], ...options })],
		});
		const code = result.outputFiles[0].text;
		const module = { exports: {} as { run?: () => unknown } };
		vm.runInNewContext(`'use strict';\n${code}`, { module, exports: module.exports });
		return { code, value: structuredClone(module.exports.run!()) };
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

describe('bytecode measurement', () => {
	it('reports a length for every function in a TypeScript module', () => {
		const ast = parse(
			'import {x} from "./x"; export function small(a: number): number { return a + 1; }\nexport const loop = (items: number[]) => { let total = 0; for (const item of items) total += item as number; return total; };\nconst object = { method(value: string) { return value.length; } };',
			{ sourceType: 'module', plugins: ['typescript'], sourceFilename: '/measure/main.ts' }
		);
		const [sizes] = measureBytecode([ast])!;
		const lengths = [...sizes.values()];
		expect(lengths).toHaveLength(3);
		const [small, loop] = lengths;
		expect(small).toBeLessThan(20);
		expect(loop).toBeGreaterThan(small * 3);
	});
});

const files = {
	'main.js':
		'/* @inline */ function tiny(x) { return x + 1; }\n' +
		'/* @inline */ function heavy(items) { let total = 0; for (const item of items) { total += item * 2; if (total > 100) total -= 7; } return total; }\n' +
		'export function run() { const items = [1, 2, 3]; return tiny(heavy(items)); }',
};

describe('bytecode measurement', () => {
	it('folds defined constants and imported constants like the bundler will', () => {
		const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'inline-fold-')));
		const flagsFile = path.join(directory, 'flags.ts');
		const mainFile = path.join(directory, 'main.ts');
		fs.writeFileSync(flagsFile, '');
		fs.writeFileSync(mainFile, '');
		const flags = parse(
			'declare const __DEBUG__: boolean; export const debugEnabled = typeof __DEBUG__ !== "undefined" ? __DEBUG__ : true;',
			{ sourceType: 'module', plugins: ['typescript'], sourceFilename: flagsFile }
		);
		const main = parse(
			'import {debugEnabled} from "./flags"; export function work(items: number[]) { if (debugEnabled) { for (const item of items) console.log("item", item, items.length); } return items.length; }',
			{ sourceType: 'module', plugins: ['typescript'], sourceFilename: mainFile }
		);
		resetMetadata();
		setResolutionConfig({
			projectRoot: directory,
			workspaceRoot: directory,
			followPackageImports: false,
		});
		collectMetadata(flags);
		collectMetadata(main);
		const [loose] = measureBytecode([main])!;
		const [folded] = measureBytecode([main], parseDefines({ __DEBUG__: 'false' }))!;
		fs.rmSync(directory, { recursive: true, force: true });
		const size = (sizes: Map<unknown, number>) => [...sizes.values()][0];
		expect(size(folded)).toBeLessThan(size(loose) / 2);
	});
});

describe('measurement cache', () => {
	it('reuses sizes from disk for an unchanged module', () => {
		const directory = fs.mkdtempSync(path.join(tmpdir(), 'inline-cache-'));
		const ast = parse('function area(w, h) { return w * h }', { sourceType: 'module' });
		try {
			setMeasureCache(directory);
			const first = measureBytecode([ast]);
			expect(measureCacheStats).toEqual({ hits: 0, misses: 1 });
			setMeasureCache(directory);
			const second = measureBytecode([ast]);
			expect(measureCacheStats).toEqual({ hits: 1, misses: 0 });
			expect([...second![0].values()]).toEqual([...first![0].values()]);
			expect(fs.readdirSync(directory)).toHaveLength(1);
		} finally {
			setMeasureCache(false);
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe('inline budget', () => {
	it('keeps a function within budget by leaving its largest expansion as a call', async () => {
		const result = await bundle(files, { budget: { max: 60 } });
		const caller = result.code.slice(result.code.indexOf('function run('));
		expect(caller).toContain('heavy(');
		expect(caller).not.toContain('tiny(');
		expect(result.value).toBe(13);
	});

	it('expands everything when the budget is disabled', async () => {
		const result = await bundle(files, { budget: false });
		const caller = result.code.slice(result.code.indexOf('function run('));
		expect(caller).not.toContain('heavy(');
		expect(result.value).toBe(13);
	});

	it('excludes as many expansions as it takes to fit', async () => {
		const result = await bundle(
			{
				'main.js':
					'/* @inline */ function first(items) { let total = 0; for (const item of items) { total += item * 2; if (total > 100) total -= 7; } return total; }\n' +
					'/* @inline */ function second(items) { let total = 1; for (const item of items) { total *= item + 1; if (total > 1000) total -= 13; } return total; }\n' +
					'export function run() { const items = [1, 2, 3]; return first(items) + second(items); }',
			},
			{ budget: { max: 150 } }
		);
		const caller = result.code.slice(result.code.indexOf('function run('));
		expect(caller).toContain('first(');
		expect(caller).toContain('second(');
		expect(result.value).toBe(36);
	});

	it('leaves functions that were already over budget free to expand', async () => {
		const result = await bundle(files, { budget: { max: 5 } });
		const caller = result.code.slice(result.code.indexOf('function run('));
		expect(caller).not.toContain('heavy(');
		expect(result.value).toBe(13);
	});
});

describe('cold branch outlining', () => {
	it('moves a throwing branch of a transformed function into its own function', async () => {
		const result = await bundle(
			{
				'main.js':
					'/* @inline */ function check(entity, trait) { if (entity < 0) throw new Error(`Entity ${entity} cannot carry ${trait.name} because it is negative`); return entity; }\n' +
					'export function run() { const trait = {name: "t"}; try { return [check(1, trait), check(-1, trait)]; } catch (error) { return error.message; } }',
			},
			{}
		);
		const caller = result.code.slice(
			result.code.indexOf('function run('),
			result.code.indexOf('function _runCold')
		);
		expect(caller).not.toContain('cannot carry');
		expect(result.code).toMatch(/function _runCold\w*\(\w+, \w+\)/);
		expect(result.value).toBe('Entity -1 cannot carry t because it is negative');
	});

	it('moves an annotated returning branch and keeps branches that write locals', async () => {
		const result = await bundle(
			{
				'main.js':
					'export function run() { const input = {mode: "slow", value: 3}; let count = 0;\n' +
					'/* @cold */ if (input.mode === "slow") { const parts = []; for (let i = 0; i < input.value; i++) parts.push(i); return parts.join("-"); }\n' +
					'/* @cold */ if (input.mode === "count") { count += input.value; }\n' +
					'return count; }',
			},
			{}
		);
		expect(result.code).toMatch(/function _runCold\w*\(input\)/);
		expect(result.code.match(/function _runCold/g)).toHaveLength(1);
		expect(result.value).toBe('0-1-2');
	});

	it('keeps throwing branches inline when disabled', async () => {
		const result = await bundle(
			{
				'main.js':
					'/* @inline */ function check(entity) { if (entity < 0) throw new Error(`Entity ${entity} is negative and cannot be used here`); return entity; }\n' +
					'export function run() { return check(2); }',
			},
			{ outlineThrows: false }
		);
		expect(result.code).not.toContain('_runCold');
		expect(result.value).toBe(2);
	});
});
