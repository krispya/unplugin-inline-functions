import { parse } from '@babel/parser';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { collectMetadata, resetMetadata, resolveSource } from '../src/collect-metadata';
import { inlineFunctions } from '../src/inline-functions';
import { resetResolutionConfig, setResolutionConfig } from '../src/utils/resolution-config';

afterEach(() => {
	resetMetadata();
	resetResolutionConfig();
});

function project() {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'inline-namespace-')));
	const resolveImport = vi.fn(() => undefined);
	const config = {
		projectRoot: directory,
		workspaceRoot: directory,
		followPackageImports: false,
		resolveImport,
	};
	resetMetadata();
	setResolutionConfig(config);
	function module(name: string, source: string) {
		const filename = path.join(directory, name);
		fs.writeFileSync(filename, source);
		const ast = parse(source, { sourceType: 'module', sourceFilename: filename });
		collectMetadata(ast);
		return ast;
	}
	return {
		directory,
		config,
		module,
		dispose: () => fs.rmSync(directory, { recursive: true, force: true }),
	};
}

it('reuses module resolution for repeated namespace calls and caches misses', () => {
	const fixture = project();
	try {
		fixture.module('vec.js', 'export /* @inline */ function twice(x) { return x * 2; }');
		fixture.module('index.js', "export * as vec from './vec.js';");
		const ast = fixture.module(
			'main.js',
			"import {vec} from './index.js'; export function run() { return vec.twice(1) + vec.twice(2) + vec.twice(3); }"
		);
		const code = inlineFunctions(ast);
		expect(code).not.toContain('vec.twice(');
		expect(fixture.config.resolveImport).toHaveBeenCalledTimes(2);
		const importer = path.join(fixture.directory, 'main.js');
		expect(resolveSource('./missing.js', importer)).toBeUndefined();
		expect(resolveSource('./missing.js', importer)).toBeUndefined();
		expect(fixture.config.resolveImport).toHaveBeenCalledTimes(3);
	} finally {
		fixture.dispose();
	}
});

it('invalidates cached exports when metadata or resolver configuration changes', () => {
	const fixture = project();
	try {
		fixture.module('vec.js', 'export const other = 1;');
		const source =
			"import * as vec from './vec.js'; export function run() { return vec.twice(3); }";
		const filename = path.join(fixture.directory, 'main.js');
		const ast = fixture.module('main.js', source);
		expect(inlineFunctions(ast)).toContain('vec.twice(');
		fixture.module('vec.js', 'export /* @inline */ function twice(x) { return x * 2; }');
		const fresh = () => parse(source, { sourceType: 'module', sourceFilename: filename });
		expect(inlineFunctions(fresh())).toContain('3 * 2');
		fixture.module('alternate.js', 'export /* @inline */ function twice(x) { return x * 5; }');
		setResolutionConfig({
			...fixture.config,
			resolveImport: () => path.join(fixture.directory, 'alternate.js'),
		});
		expect(inlineFunctions(fresh())).toContain('3 * 5');
		resetMetadata();
		expect(inlineFunctions(fresh())).toContain('vec.twice(');
	} finally {
		fixture.dispose();
	}
});

it('resolves cyclic barrels without caching a partial traversal', () => {
	const fixture = project();
	try {
		fixture.module('vec.js', 'export /* @inline */ function twice(x) { return x * 2; }');
		fixture.module('a.js', "export * from './b.js'; export * from './vec.js';");
		fixture.module('b.js', "export * from './a.js';");
		const ast = fixture.module(
			'main.js',
			"import * as a from './a.js'; import * as b from './b.js'; export function run() { return a.twice(2) + b.twice(3); }"
		);
		const code = inlineFunctions(ast);
		expect(code).not.toMatch(/\b[ab]\.twice\(/);
		expect(code).toContain('2 * 2 + 3 * 2');
	} finally {
		fixture.dispose();
	}
});

it('leaves ambiguous exports and receiver-dependent or uninitialized functions as calls', () => {
	const fixture = project();
	try {
		fixture.module(
			'vec.js',
			`export /* @inline */ function twice(x) { return x * 2; }
			export /* @inline */ function receiver() { return this; }
			export /* @inline */ const arrow = () => 1;`
		);
		fixture.module('other.js', 'export const twice = 3;');
		fixture.module('index.js', "export * from './vec.js'; export * from './other.js';");
		const ast = fixture.module(
			'main.js',
			`import * as ns from './index.js'; import * as vec from './vec.js';
			export function run() { return [ns.twice(1), vec.receiver(), vec.arrow()]; }`
		);
		const code = inlineFunctions(ast);
		expect(code).toContain('ns.twice(1)');
		expect(code).toContain('vec.receiver()');
		expect(code).toContain('vec.arrow()');
	} finally {
		fixture.dispose();
	}
});

it('gives explicit exports precedence over conflicting star exports in any order', () => {
	const fixture = project();
	try {
		fixture.module('first.js', 'export /* @inline */ function value() { return 1; }');
		fixture.module('second.js', 'export /* @inline */ function value() { return 2; }');
		fixture.module(
			'index.js',
			"export * from './first.js'; export * from './second.js'; export {value} from './second.js';"
		);
		const ast = fixture.module(
			'main.js',
			"import * as ns from './index.js'; export function run() { return ns.value(); }"
		);
		const code = inlineFunctions(ast);
		expect(code).not.toContain('ns.value(');
		expect(code).toContain('return 2');
	} finally {
		fixture.dispose();
	}
});
