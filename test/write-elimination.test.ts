import _generate from '@babel/generator';
import { parse } from '@babel/parser';
import _traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { collectMetadata, resetMetadata } from '../src/collect-metadata';
import { dedupVariables } from '../src/dedup-variables';
import { eliminateWrites } from '../src/eliminate-writes';
import { inlineFunctions } from '../src/inline-functions';
import { getBabelDefaultExport } from '../src/utils/babel-exports';

const generate = getBabelDefaultExport(_generate);
const traverse = getBabelDefaultExport(_traverse);

function optimize(source: string) {
	const ast = parse(source);
	const functions: NodePath<t.Function>[] = [];
	traverse(ast, {
		FunctionDeclaration(path) {
			if (path.node.id?.name === 'run') functions.push(path);
		},
	});
	dedupVariables(functions);
	eliminateWrites(functions);
	return generate(ast).code;
}

async function execute(source: string) {
	const value = await vm.runInNewContext(`'use strict';\n${source}\nrun();`, {}, { timeout: 1000 });
	return structuredClone(value);
}

const safe = [
	[
		'overwritten own data stores',
		'const object = {x: 0}; object.x = 1; object.x = 2; return object.x;',
		'object.x = 1;',
	],
	[
		'object aliases',
		'const object = {x: 0}; const alias = object; object.x = 1; alias.x = 2; return object.x;',
		'object.x = 1;',
	],
	[
		'literal computed keys',
		'const object = {x: 0}; object["x"] = 1; object.x = 2; return object.x;',
		'object["x"] = 1;',
	],
	[
		'numeric computed keys',
		'const object = {1: 0}; object[1] = 1; object["1"] = 2; return object[1];',
		'object[1] = 1;',
	],
	[
		'nested data slots',
		'const object = {child: {x: 0}}; object.child.x = 1; object.child.x = 2; return object.child.x;',
		'object.child.x = 1;',
	],
	[
		'independent slots',
		'const object = {x: 0, y: 0}; object.x = 1; object.y = 3; object.x = 2; return [object.x, object.y];',
		'object.x = 1;',
	],
	[
		'independent reads',
		'const object = {x: 0, y: 4}; object.x = 1; const value = object.y; object.x = 2; return [object.x, value];',
		'object.x = 1;',
	],
	[
		'allocation RHS',
		'const object = {x: 0}; object.x = {unused: 1}; object.x = {kept: 2}; return object.x;',
		'unused:',
	],
	['primitive local assignments', 'let value; value = 1; value = 2; return value;', 'value = 1;'],
	['overwritten let initializer', 'let value = 1; value = 2; return value;', 'let value = 1;'],
	['overwritten var initializer', 'var value = 1; value = 2; return value;', 'var value = 1;'],
	['redeclared vars', 'var value = 1; var value; value = 2; return value;', 'var value = 1;'],
	[
		'overwritten object initializer',
		'let value = {unused: 1}; value = {kept: 2}; return value;',
		'unused:',
	],
	[
		'multiple stores',
		'const object = {x: 0}; object.x = 1; object.x = 2; object.x = 3; return object.x;',
		'object.x = 1;',
	],
	[
		'a local captured but not observed until after overwrite',
		'let value = 1; const later = () => value; value = 2; return later();',
		'let value = 1;',
	],
	[
		'data proof after a safe store',
		'const object = {child: 0}; object.child = {x: 0}; object.child.x = 1; object.child.x = 2; return object.child.x;',
		'object.child.x = 1;',
	],
];

describe('safe write elimination', () => {
	it.each(safe)('%s', async (_name, body, removed) => {
		const source = `function run() { ${body} }`;
		const code = optimize(source);
		expect(code).not.toContain(removed);
		expect(await execute(code)).toEqual(await execute(source));
	});
	it('optimizes within a branch', async () => {
		const source =
			'function run() { if (true) { const object = {x: 0}; object.x = 1; object.x = 2; return object.x; } }';
		const code = optimize(source);
		expect(code).not.toContain('object.x = 1;');
		expect(await execute(code)).toEqual(await execute(source));
	});
	it('composes read reuse and store elimination in the inlining pipeline', async () => {
		const source =
			'/* @inline */ function update(object) { const first = object.x; const second = object.x; object.x = 10; object.x = 20; return [first, second, object.x]; } function run() { const object = {x: 1}; return update(object); }';
		const ast = parse(source, { sourceFilename: '/test/write.js' });
		resetMetadata();
		collectMetadata(ast);
		const code = inlineFunctions(ast);
		expect(code).toMatch(/const _second\w* = _first\w*;/);
		expect(code).not.toMatch(/_object\w*\.x = 10/);
		expect(code).toMatch(/_object\w*\.x = 20/);
		expect(await execute(code)).toEqual(await execute(source));
	});
});

const unsafe = [
	['the final store is observable', 'const object = {x: 0}; object.x = 1; return object.x;'],
	[
		'a replaced child is a different object',
		'const object = {child: {x: 0}}; const alias = object.child; alias.x = 1; object.child = {x: 0}; object.child.x = 2; return [alias.x, object.child.x];',
	],
	[
		'shared memory',
		'const buffer = new SharedArrayBuffer(4); const object = new Int32Array(buffer); object[0] = 1; object[0] = 2; return Atomics.load(object, 0);',
	],
	[
		'reads of the old value',
		'const object = {x: 0}; object.x = 1; const first = object.x; object.x = 2; return [first, object.x];',
	],
	[
		'alias reads of the old value',
		'const object = {x: 0}; const alias = object; object.x = 1; const first = alias.x; object.x = 2; return [first, object.x];',
	],
	[
		'RHS reads of the old value',
		'const object = {x: 0}; object.x = 1; object.x = object.x; return object.x;',
	],
	[
		'nested target reads',
		'const object = {child: {x: 0}}; object.child = {x: 1}; object.child.x = 2; return object.child.x;',
	],
	[
		'setters',
		'const log = []; const object = {set x(value) { log.push(value); }}; object.x = 1; object.x = 2; return log;',
	],
	[
		'proxies',
		'const log = []; const object = new Proxy({}, {set(_target, _key, value) { log.push(value); return true; }}); object.x = 1; object.x = 2; return log;',
	],
	[
		'inherited setters',
		'const log = []; const object = {__proto__: {set x(value) { log.push(value); }}}; object.x = 1; object.x = 2; return log;',
	],
	['new properties', 'const object = {}; object.x = 1; object.x = 2; return object.x;'],
	[
		'unknown calls can observe memory',
		'const object = {x: 0}; const log = []; function observe() { log.push(object.x); } object.x = 1; observe(); object.x = 2; return [log, object.x];',
	],
	[
		'pure calls can observe memory',
		'const object = {x: 0}; const log = []; /* @pure */ function observe() { log.push(object.x); } object.x = 1; /* @__PURE__ */ observe(); object.x = 2; return [log, object.x];',
	],
	[
		'effects in the old RHS',
		'const object = {x: 0}; const log = []; object.x = (log.push(1), 1); object.x = 2; return [log, object.x];',
	],
	[
		'effects in the overwriting RHS',
		'const object = {x: 0}; const log = []; function observe() { log.push(object.x); return 2; } object.x = 1; object.x = observe(); return [log, object.x];',
	],
	[
		'RHS descriptor replacement',
		'const object = {x: 0}; const log = []; function change() { Object.defineProperty(object, "x", {set(value) { log.push(value); }}); return 1; } object.x = change(); object.x = 2; return log;',
	],
	[
		'throwing RHS',
		'const object = {x: 0}; function fail() { throw 0; } try { object.x = 1; object.x = fail(); } catch {} return object.x;',
	],
	[
		'non-writable descriptors',
		'const object = {x: 0}; object.x = 1; Object.freeze(object); try { object.x = 2; } catch {} return object.x;',
	],
	[
		'getters in unrelated reads',
		'const object = {x: 0}; const log = []; const other = {get y() { log.push(object.x); return 0; }}; object.x = 1; const ignored = other.y; object.x = 2; return [log, ignored, object.x];',
	],
	[
		'dynamic keys',
		'const object = {x: 0}; const log = []; const key = {toString() { log.push(object.x); return "x"; }}; object[key] = 1; object[key] = 2; return [log, object.x];',
	],
	[
		'deletion',
		'const object = {x: 0}; object.x = 1; delete object.x; object.x = 2; return object.x;',
	],
	['compound assignments', 'const object = {x: 0}; object.x = 1; object.x += 2; return object.x;'],
	['logical assignments', 'const object = {x: 0}; object.x = 1; object.x ||= 2; return object.x;'],
	['updates', 'const object = {x: 0}; object.x = 1; object.x++; return object.x;'],
	[
		'assignment values',
		'const object = {x: 0}; object.x = 1; const value = (object.x = 2); return [value, object.x];',
	],
	[
		'object escape',
		'const object = {x: 0}; object.x = 1; globalThis.saved = object; object.x = 2; return globalThis.saved.x;',
	],
	[
		'branch joins',
		'const object = {x: 0}; object.x = 1; if (false) object.x = 2; return object.x;',
	],
	[
		'loop boundaries',
		'const object = {x: 0}; object.x = 1; for (let i = 0; i < 0; i++) { object.x = 2; } return object.x;',
	],
	[
		'try/finally boundaries',
		'const object = {x: 0}; const log = []; try { object.x = 1; } finally { log.push(object.x); } object.x = 2; return [log, object.x];',
	],
	[
		'separate blocks',
		'const object = {x: 0}; { object.x = 1; } { object.x = 2; } return object.x;',
	],
	[
		'typed arrays',
		'const object = new Uint8Array([0]); object[0] = 1; object[0] = 2; return object[0];',
	],
	['local reads', 'let value = 1; const first = value; value = 2; return [first, value];'],
	['local RHS reads', 'let value = 1; value = value; return value;'],
	[
		'captured local reads through calls',
		'let value = 1; const log = []; function observe() { log.push(value); } observe(); value = 2; return [log, value];',
	],
	[
		'local assignment effects',
		'const log = []; let value = log.push(1); value = 2; return [log, value];',
	],
	[
		'parameter bindings',
		'function nested(value) { value = 1; value = 2; return value; } return nested(0);',
	],
	[
		'TDZ errors',
		'try { value = 1; let value; value = 2; return value; } catch (error) { return error.name; }',
	],
	['direct eval', 'let value = 1; const first = eval("value"); value = 2; return [first, value];'],
	['destructuring assignments', 'let value = 1; [value] = [2]; return value;'],
];

describe('write elimination barriers', () => {
	it.each(unsafe)('%s', async (_name, body) => {
		const source = `function run() { ${body} }`;
		const code = optimize(source);
		expect(code).toBe(generate(parse(source)).code);
		expect(await execute(code)).toEqual(await execute(source));
	});
	it('retains stores visible across suspension', async () => {
		const source =
			'async function run() { const object = {x: 0}; const log = []; object.x = 1; await Promise.resolve().then(() => log.push(object.x)); object.x = 2; return [log, object.x]; }';
		const code = optimize(source);
		expect(code).toBe(generate(parse(source)).code);
		expect(await execute(code)).toEqual(await execute(source));
	});
	it('excludes parameter bindings even when redeclared with var', async () => {
		const source =
			'function run(value) { var value = 1; value = 2; return [value, arguments[0]]; }';
		const code = optimize(source);
		expect(code).toBe(generate(parse(source)).code);
		expect(await execute(code)).toEqual(await execute(source));
	});
	it('forgets store candidates at generator suspension', async () => {
		const source =
			'function* run() { const object = {x: 0}; object.x = 1; yield object; object.x = 2; return object.x; }';
		const code = optimize(source);
		expect(code).toBe(generate(parse(source)).code);
		for (const candidate of [source, code]) {
			const values = vm.runInNewContext(
				`${candidate}\nconst iterator = run(); const first = iterator.next().value.x; const second = iterator.next().value; [first, second];`
			);
			expect(structuredClone(values)).toEqual([1, 2]);
		}
	});
});
