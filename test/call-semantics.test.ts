import { build } from 'esbuild';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import inlineFunctions from '../src/esbuild';

async function compareBuilds(files: Record<string, string>, inlined?: string) {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'inline-semantics-')));
	try {
		for (const [filename, source] of Object.entries(files)) {
			const target = path.join(directory, filename);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, source);
		}
		const results: { value: unknown; code: string }[] = [];
		for (const enabled of [false, true]) {
			const result = await build({
				entryPoints: [path.join(directory, 'main.js')],
				bundle: true,
				write: false,
				format: 'cjs',
				platform: 'node',
				logLevel: 'silent',
				plugins: enabled ? [inlineFunctions({ cwd: directory, include: ['**/*.js'] })] : [],
			});
			const code = result.outputFiles[0].text;
			const module = { exports: {} };
			const value = await vm.runInNewContext(
				`'use strict';\n${code}\nmodule.exports.run();`,
				{ module, exports: module.exports },
				{ timeout: 1000 }
			);
			results.push({ value: structuredClone(value), code });
		}
		expect(results[1].value).toEqual(results[0].value);
		if (inlined)
			expect(results[1].code).not.toMatch(new RegExp(`(?<!function )\\b${inlined}\\s*\\(`));
		return results[1];
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
}

const cases = [
	{
		name: 'repeated argument',
		source: '/* @inline */ function twice(x) { return x + x; }\nfunction run() { let n = 0; const value = twice(++n); return [value, n]; }\nexport {run};',
		inlined: 'twice',
	},
	{
		name: 'unused argument',
		source: '/* @inline */ function discard(x) { return 7; }\nfunction run() { let n = 0; const value = discard(++n); return [value, n]; }\nexport {run};',
		inlined: 'discard',
	},
	{
		name: 'parameter write',
		source: '/* @inline */ function increment(x) { x++; return x; }\nfunction run() { let n = 3; const value = increment(n); return [value, n]; }\nexport {run};',
		inlined: 'increment',
	},
	{
		name: 'argument order',
		source: "/* @inline */ function reverse(a, b) { return [b, a]; }\nfunction run() { const trace = []; function next(x) { trace.push(x); return x; } const value = reverse(next('a'), next('b')); return [value, trace]; }\nexport {run};",
		inlined: 'reverse',
	},
	{
		name: 'skipped branch',
		source: "/* @inline */ function touch(log) { log.push('called'); return 1; }\nfunction run() { const log = []; const result = false && touch(log); return [result, log]; }\nexport {run};",
		inlined: 'touch',
	},
	{
		name: 'loop condition',
		source: '/* @inline */ function keepGoing(i) { const current = i; return current < 3; }\nfunction run() { const out = []; for (let i = 0; keepGoing(i); i++) out.push(i); return out; }\nexport {run};',
		inlined: 'keepGoing',
	},
	{
		name: 'conditional return',
		source: '/* @inline */ function maybe(x) { if (x) return 1; }\nfunction run() { return maybe(false); }\nexport {run};',
		inlined: 'maybe',
	},
	{
		name: 'early return with else',
		source: '/* @inline */ function choose(x) { if (x) { return 1; } else { const ignored = 2; } return 3; }\nfunction run() { return choose(true); }\nexport {run};',
		inlined: 'choose',
	},
	{
		name: 'nested function return',
		source: '/* @inline */ function outer() { function nested() { return 2; } return nested() + 1; }\nfunction run() { return outer(); }\nexport {run};',
		inlined: 'outer',
	},
	{
		name: 'object property key',
		source: '/* @inline */ function wrap(x) { return { x: x }; }\nfunction run() { return wrap(3); }\nexport {run};',
		inlined: 'wrap',
	},
	{
		name: 'shadowed callee',
		source: '/* @inline */ function helper(x) { return x + 1; }\nfunction call(helper) { return helper(10); }\nfunction run() { return call(x => x * 2); }\nexport {run};',
		inlined: null,
	},
	{
		name: 'dedup across write',
		source: '/* @inline @pure */ function readX(o) { const value = o.x; return value; }\nfunction run() { const o = { x: 1 }; const a = readX(o); o.x = 2; const b = readX(o); return [a, b]; }\nexport {run};',
		inlined: 'readX',
	},
	{
		name: 'dedup across call',
		source: '/* @inline @pure */ function readY(o) { const value = o.y; return value; }\nfunction mutate(o) { o.y = 2; }\nfunction run() { const o = { y: 1 }; const a = readY(o); mutate(o); const b = readY(o); return [a, b]; }\nexport {run};',
		inlined: 'readY',
	},
	{
		name: 'dedup across blocks',
		source: '/* @inline @pure */ function readZ(o) { const value = o.z; return value; }\nfunction run() { const o = { z: 1 }; const out = []; { const a = readZ(o); out.push(a); } { const b = readZ(o); out.push(b); } return out; }\nexport {run};',
		inlined: 'readZ',
	},
	{
		name: 'dedup allocations',
		source: '/* @inline @pure */ function make() { const value = {}; return value; }\nfunction run() { return make() === make(); }\nexport {run};',
		inlined: 'make',
	},
	{
		name: 'missing argument',
		source: '/* @inline */ function add(a, b) { return a + (b ?? 1); }\nfunction run() { return add(2); }\nexport {run};',
		inlined: 'add',
	},
	{
		name: 'default parameter position',
		source: '/* @inline */ function second(a = 5, b) { return b; }\nfunction run() { return second(undefined, 3); }\nexport {run};',
		inlined: null,
	},
	{
		name: 'void expression',
		source: '/* @inline */ function record(log) { log.push(1); }\nfunction run() { const log = []; const value = record(log); return [value, log]; }\nexport {run};',
		inlined: 'record',
	},
	{
		name: 'hoisted binding',
		source: '/* @inline */ function beforeDeclaration() { const before = typeof x; var x = 1; return before; }\nfunction run() { const x = 10; return beforeDeclaration(); }\nexport {run};',
		inlined: 'beforeDeclaration',
	},
	{
		name: 'extra arguments execute before the body',
		source: '/* @inline */ function first(x) { return x; } function run() { let n = 0; const value = first(++n, ++n); return [value, n]; }\nexport {run};',
		inlined: 'first',
	},
	{
		name: 'argument values are captured before subsequent arguments mutate them',
		source: '/* @inline */ function pair(a, b) { return [a, b]; } function run() { let x = 1; return pair(x, x = 2); }\nexport {run};',
		inlined: 'pair',
	},
	{
		name: 'nested calls preserve the outer callee evaluation',
		source: "let target = () => 'old'; /* @inline */ function change() { target = () => 'new'; return 1; } function run() { return target(change()); }\nexport {run};",
		inlined: 'change',
	},
	{
		name: 'loop invocations reset hoisted vars',
		source: '/* @inline */ function maybe(flag) { if (flag) var value = 1; return typeof value; } function run() { const out = []; for (const flag of [true, false]) out.push(maybe(flag)); return out; }\nexport {run};',
		inlined: 'maybe',
	},
	{
		name: 'closures capture a fresh invocation frame',
		source: '/* @inline */ function make(value) { var count = value; return () => ++count; } function run() { const a = make(1); const b = make(10); return [a(), b(), a()]; }\nexport {run};',
		inlined: 'make',
	},
	{
		name: 'var redeclarations share the parameter binding',
		source: '/* @inline */ function twice(x) { var x = x * 2; return x; } function run() { return twice(3); }\nexport {run};',
		inlined: 'twice',
	},
	{
		name: 'nested scopes and catch bindings keep their own names',
		source: '/* @inline */ function scoped(x) { const object = {x}; { const x = 9; object.inner = x; } try { throw 4; } catch (x) { object.caught = x; } return object; } function run() { return scoped(2); }\nexport {run};',
		inlined: 'scoped',
	},
	{
		name: 'destructured locals preserve object keys',
		source: '/* @inline */ function unpack(object) { const {x: value} = object; return {value, x: value}; } function run() { return unpack({x: 3}); }\nexport {run};',
		inlined: 'unpack',
	},
	{
		name: 'returned methods are called without a receiver',
		source: '/* @inline */ function method(object) { return object.fn; } function run() { const object = {fn() { return this === undefined; }}; return method(object)(); }\nexport {run};',
		inlined: 'method',
	},
	{
		name: 'delete operates on the call value',
		source: '/* @inline */ function read(object) { return object.x; } function run() { const object = {x: 1}; const result = delete read(object); return [result, object.x]; }\nexport {run};',
		inlined: 'read',
	},
	{
		name: 'anonymous returned functions keep their inferred names',
		source: '/* @inline */ function make() { return function() {}; } function run() { const fn = make(); return fn.name; }\nexport {run};',
		inlined: 'make',
	},
	{
		name: 'finally runs and can override the return',
		source: "/* @inline */ function choose(log) { try { return 1; } finally { log.push('finally'); return 2; } } function run() { const log = []; return [choose(log), log]; }\nexport {run};",
		inlined: 'choose',
	},
	{
		name: 'loop returns exit the entire inline frame',
		source: '/* @inline */ function find(items) { for (var i = 0; i < items.length; i++) { if (items[i] > 2) return items[i]; } return null; } function run() { return [find([1, 4, 5]), find([1])]; }\nexport {run};',
		inlined: 'find',
	},
	{
		name: 'spread arguments remain native',
		source: '/* @inline */ function sum(a, b) { return a + b; } function run() { return sum(...[2, 3]); }\nexport {run};',
		inlined: null,
	},
	{
		name: 'destructured and rest parameters remain native',
		source: '/* @inline */ function sum({x}, ...values) { return x + values[0]; } function run() { return sum({x: 2}, 3); }\nexport {run};',
		inlined: null,
	},
	{
		name: 'async and arguments dependent functions remain native',
		source: '/* @inline */ async function first(x) { return x; } /* @inline */ function count(x) { return arguments.length; } async function run() { return [await first(2), count(1, 2)]; }\nexport {run};',
		inlined: null,
	},
	{
		name: 'recursive functions remain native',
		source: '/* @inline */ function factorial(n) { return n ? n * factorial(n - 1) : 1; } function run() { return factorial(5); }\nexport {run};',
		inlined: null,
	},
	{
		name: 'mutually recursive functions do not expand indefinitely',
		source: '/* @inline */ function even(n) { return n === 0 || odd(n - 1); } /* @inline */ function odd(n) { return n !== 0 && even(n - 1); } function run() { return even(4); }\nexport {run};',
		inlined: null,
	},
	{
		name: 'function reassignments are respected',
		source: '/* @inline */ function add(x) { return x + 1; } function run() { add = x => x * 2; return add(3); }\nexport {run};',
		inlined: null,
	},
	{
		name: 'caller globals do not capture callee free names',
		source: 'const value = 1; /* @inline */ function read() { return value; } function caller(value) { return read(); } function run() { return caller(2); }\nexport {run};',
		inlined: null,
	},
	{
		name: 'generated bindings do not collide with caller identifiers',
		source: '/* @inline */ function add(x) { const value = x + 1; return value; } function run() { const _arg = 10; const _value = 20; const _result = 30; const _inline = 40; return [add(2), _arg, _value, _result, _inline]; }\nexport {run};',
		inlined: 'add',
	},
	{
		name: 'argument functions keep their anonymous names',
		source: '/* @inline */ function name(fn) { return fn.name; } function run() { return [name(() => 1), name(function() {})]; }\nexport {run};',
		inlined: null,
	},
	{
		name: 'escaped named declarations keep their names',
		source: '/* @inline */ function make() { function helper() { return 1; } return helper; } function run() { return make().name; }\nexport {run};',
		inlined: null,
	},
	{
		name: 'escaped local arrows keep their inferred names',
		source: '/* @inline */ function make() { const helper = () => 1; return helper; } function run() { return make().name; }\nexport {run};',
		inlined: null,
	},
	{
		name: 'named function expressions keep self bindings',
		source: 'const make = /* @inline */ function self() { return self.name; }; function run() { return make(); }\nexport {run};',
		inlined: null,
	},
	{
		name: 'arrow function parameters are invocation-local',
		source: 'const twice = /* @inline */ x => { x++; return x + x; }; function run() { let x = 2; return [twice(x), x]; }\nexport {run};',
		inlined: null,
	},
	{
		name: 'uninitialized function variables retain native failures',
		source: 'function run() { let count = 0; try { fn(++count); } catch (error) { return [error.name, count]; } var fn = /* @inline */ (x) => x; }\nexport {run};',
		inlined: null,
	},
	{
		name: 'labels inside expanded functions do not collide',
		source: '/* @inline */ function choose() { outer: for (let i = 0; i < 3; i++) { if (i === 1) break outer; } return 2; } function run() { outer: { return choose(); } }\nexport {run};',
		inlined: null,
	},
	{
		name: 'function parameters are not inlined before initialization',
		source: '/* @inline */ function identity(x) { return x; } function fn(a = identity(b), b = 2) { return a; } function run() { try { fn(); } catch (error) { return error.name; } }\nexport {run};',
		inlined: null,
	},
	{
		name: 'awaited arguments keep their async execution context',
		source: '/* @inline */ function identity(x) { return x; } async function run() { return identity(await Promise.resolve(2)); }\nexport {run};',
		inlined: null,
	},
	{
		name: 'ordered effectful inputs substitute into a leading member chain',
		source: "/* @inline */ function read(data, key) { return data[key.id]; } function run() { const log = []; const value = read((log.push('data'), {x: 3}), (log.push('key'), {id: 'x'})); return [value, log]; }\nexport {run};",
		inlined: 'read',
	},
	{
		name: 'effectful inputs after a body effect keep their order',
		source: "const log = []; /* @inline */ function read(data, key) { log.push('body'); return data[key.id]; } function run() { const value = read((log.push('data'), {x: 3}), (log.push('key'), {id: 'x'})); return [value, log]; }\nexport {run};",
		inlined: 'read',
	},
	{
		name: 'early returns inside loops at a declaration site',
		source: '/* @inline */ function find(items, limit) { for (const item of items) { if (item > limit) return item; } return -1; } function run() { const first = find([1, 5, 9], 4); const none = find([1], 4); return [first, none]; }\nexport {run};',
		inlined: 'find',
	},
	{
		name: 'multi-exit bodies in a condition',
		source: '/* @inline */ function classify(value) { if (value < 0) return "negative"; if (value === 0) return "zero"; return "positive"; } function run() { const out = []; for (const value of [-1, 0, 1]) { if (classify(value) === "zero") out.push("z"); else out.push(classify(value)); } return out; }\nexport {run};',
		inlined: 'classify',
	},
	{
		name: 'loop bodies in a conditional operand',
		source: '/* @inline */ function any(items) { for (const item of items) if (item) return true; return false; } function run() { const log = []; const a = log.push(1) && any([0, 1]); const b = false || any([0]); return [a, b, log]; }\nexport {run};',
		inlined: 'any',
	},
	{
		name: 'exported and loop head declarations',
		source: '/* @inline */ function twice(x) { const value = x * 2; if (value > 100) return 100; return value; } export const limit = twice(60); function run() { const out = []; for (let i = twice(1), n = 0; n < 2; n++) out.push(i + n); return [limit, out]; }\nexport {run};',
		inlined: 'twice',
	},
	{
		name: 'concise arrows expanding a call',
		source: '/* @inline */ function clamp(x) { if (x > 1) return 1; return x; } function run() { return [0.5, 2].map(x => clamp(x) * 10); }\nexport {run};',
		inlined: 'clamp',
	},
	{
		name: 'spliced bodies at a for-of head run once',
		source: '/* @inline */ function items(log) { log.push("items"); const list = [1, 2]; return list; } function run() { const log = []; for (const item of items(log)) log.push(item); return log; }\nexport {run};',
		inlined: 'items',
	},
	{
		name: 'if-test splices keep their consequent block',
		source: '/* @inline */ function ready(state) { const count = state.count; return count > 0; } function run() { const state = {count: 1}; let hits = 0; if (ready(state)) hits++; else hits--; for (let i = 0; i < 2; i++) if (ready(state)) hits++; return hits; }\nexport {run};',
		inlined: 'ready',
	},
];

describe('call semantics', () => {
	it.each(cases)('$name', async ({ source, inlined }) => {
		await compareBuilds({ 'main.js': source }, inlined || undefined);
	});

	it('eliminates simple function calls without an invocation wrapper', async () => {
		const result = await compareBuilds(
			{
				'main.js':
					'/* @inline */ function twice(x) { return x + x; } export function run() { return twice(3); }',
			},
			'twice'
		);
		expect(result.code.slice(result.code.indexOf('function run('))).not.toContain('=>');
	});

	it('splices single-exit bodies ahead of a leading condition without temporaries', async () => {
		const result = await compareBuilds(
			{
				'main.js':
					'/* @inline */ function ready(state) { const count = state.count; return count > 0; } export function run() { const state = {count: 1}; if (ready(state)) return "yes"; return "no"; }',
			},
			'ready'
		);
		const caller = result.code.slice(result.code.indexOf('function run('));
		expect(caller).not.toContain('_result');
		expect(caller).not.toContain('_inline');
		expect(caller).toMatch(/const _count\w* = state\.count;\s*if \(_count\w* > 0\)/);
	});

	it('assigns a declared variable directly from a multi-exit body', async () => {
		const result = await compareBuilds(
			{
				'main.js':
					'/* @inline */ function sign(x) { if (x < 0) return -1; if (x > 0) return 1; return 0; } export function run() { const value = sign(3); return value; }',
			},
			'sign'
		);
		const caller = result.code.slice(result.code.indexOf('function run('));
		expect(caller).not.toContain('_result');
		expect(caller).not.toContain('_inline');
		expect(caller).toContain('let value;');
	});

	it('flattens block bodies at direct statement sites', async () => {
		const result = await compareBuilds(
			{
				'main.js':
					'/* @inline */ function bump(counter) { counter.value++; } export function run() { const counter = {value:0}; bump(counter); return counter.value; }',
			},
			'bump'
		);
		expect(result.code.slice(result.code.indexOf('function run('))).not.toContain('=>');
	});
});

const any =
	'/* @inline */ function any(items) { for (let i = 0; i < items.length; i++) if (items[i]) return true; return false; }';
const positive =
	'/* @inline */ function positive(n) { if (n < 0) throw new Error("negative"); return n > 0; }';

// Bodies that need statements, at positions only some paths evaluate.
const flattenedCases: { name: string; source: string; inlined?: string }[] = [
	{
		name: 'a returned conditional',
		source: `${any} function pick(c, xs) { return c ? xs.length : any(xs); } function run() { return [pick(true, [1]), pick(false, [0, 2]), pick(false, [0])]; }`,
	},
	{
		name: 'returned logical operands',
		source: `${any} function run() { const log = []; function and(a, xs) { return a && any(xs); } function or(xs) { return log.push(1) > 2 || any(xs); } function nullish(a, xs) { return a ?? any(xs); } return [and(0, [1]), and(1, [1]), or([0]), or([1]), or([0]), nullish(0, [1]), nullish(null, [1]), log]; }`,
	},
	{
		name: 'unused values',
		source: '/* @inline */ function any(out, n) { for (let i = 0; i < n; i++) out.push(i); } function run() { const out = []; const c = out.length; c && any(out, 9); c || any(out, 2); c ? any(out, 9) : 0; c ? 0 : any(out, 1); out[9] ?? any(out, 1); return out; }',
	},
	{
		name: 'nested conditionals',
		source: `${any} function pick(a, b, xs) { return a ? (b ? any(xs) : 1) : 2; } function run() { return [pick(1, 1, [1]), pick(1, 1, [0]), pick(1, 0, [1]), pick(0, 1, [1])]; }`,
	},
	{
		name: 'a conditional argument between effectful operands',
		source: `${any} function run() { const log = []; function next() { log.push(log.length); return log.length; } function list(a, b, c) { return [a, b, c]; } return [list(next(), log.length ? any([1]) : 0, next()), log]; }`,
	},
	{
		name: 'declared and assigned values',
		source: `${any} function run() { const log = []; const a = log.push(1) && any([0, 1]); let b; b = log.length > 5 ? 0 : any([0]); const c = [log.length ? any([1]) : 0]; return [a, b, c, log]; }`,
	},
	{
		name: 'anonymous functions beside a flattened branch',
		source: `${positive} function run() { const yes = [1].length; const a = yes ? () => 1 : positive(0); const b = [yes ? () => 1 : positive(0)]; return [a.name, b[0].name]; }`,
		inlined: 'positive',
	},
	{
		name: 'a while test',
		source: '/* @inline */ function any(q) { for (const v of q) if (v > 0) return true; return false; } function run() { const q = [3, 2, 1]; const out = []; while (any(q)) { const v = q.shift(); if (v === 2) continue; out.push(v); q.push(0); if (out.length > 5) break; } return out; }',
	},
	{
		name: 'a for test with fresh bindings on each pass',
		source: '/* @inline */ function any(q, i) { for (const v of q) if (v > i) return true; return false; } function run() { const out = []; const reads = []; for (let i = 0; i < 9 && any([1, 2, 3], i); i++) { if (i === 1) continue; out.push(i); reads.push(() => i); } return [out, reads.map((read) => read())]; }',
	},
	{
		name: 'an and chain in a loop test',
		source: '/* @inline */ function any(q) { for (const v of q) if (v > 0) return true; return false; } function run() { const q = [3, 2, 1, 0]; const out = []; while (out.length < 2 && any(q) && q.length) out.push(q.shift()); return out; }',
	},
	{
		name: 'if tests',
		source: `${any} function kind(a, xs) { if (a > 5) return "big"; else if (a && any(xs)) return "any"; if (a < 0 || any(xs)) return "or"; if (a && any(xs)) { return "and"; } else return "none"; } function run() { return [kind(9, []), kind(1, [1]), kind(1, [0]), kind(0, [1]), kind(-1, [0]), kind(0, [0])]; }`,
	},
	{
		name: 'switch cases, bare branches and concise arrows',
		source: `${any} function pick(k, xs) { switch (k) { case 1: return xs.length ? any(xs) : -1; default: if (k) return k > 2 && any(xs); } return 0; } function run() { return [pick(1, [1]), pick(1, []), pick(3, [0]), pick(2, [1]), pick(0, [1]), [[1], [0], []].map((xs) => xs.length && any(xs))]; }`,
	},
	{
		name: 'a branch beside await',
		source: `${any} async function run() { const a = (await 1) ? any([1]) : await 2; const b = (await 0) || any([0]); return [a, b]; }`,
	},
];

// Positions with no statement form. The call stays rather than run inside a function.
const keptCases = [
	{
		name: 'an optional chain operand',
		source: `${any} function run() { const none = null; const some = {a: 1, b: 2}; return [none?.[any([1])], some?.[any([1]) ? "a" : "b"]]; }`,
	},
	{
		name: 'a do while test',
		source: `${any} function run() { const q = [1, 0]; let n = 0; do { q.shift(); n++; } while (any(q)); return n; }`,
	},
	{
		name: 'a for update',
		source: `${any} function run() { const out = []; for (let i = 0, found = false; i < 3; found = any([i]), i++) out.push(found); return out; }`,
	},
	{
		name: 'a later declarator',
		source: `${any} function run() { const first = [0, 1], found = any(first); return found; }`,
	},
	{
		name: 'a parameter default',
		source: `${any} function run() { function read(found = any([0, 1])) { return found; } return [read(), read(0)]; }`,
	},
	{
		name: 'a branch whose body writes a compound assignment target',
		source: 'let total = 1; /* @inline */ function any(n) { for (let i = 0; i < n; i++) total += 10; return 1; } function run() { total = 1; total += total ? any(1) : 0; return total; }',
	},
];

// Evaluation order around code that moves ahead of its statement.
const orderCases = [
	{
		name: 'and around a body that ends without returning',
		source: '/* @inline */ function find(xs) { for (const x of xs) if (x > 1) return x; } function run() { const ok = [1].length; const a = ok && find([0]); return [a]; }',
	},
	{
		name: 'or around a body that ends without returning',
		source: '/* @inline */ function find(xs) { for (const x of xs) if (x > 1) return x; } function run() { const ok = [].length; const a = ok || find([0]); return [a]; }',
	},
	{
		name: 'nullish around a body that ends without returning',
		source: '/* @inline */ function find(xs) { for (const x of xs) if (x > 1) return x; } function run() { const ok = [null][0]; const a = ok ?? find([0]); return [a]; }',
	},
	{
		name: 'a passed on value from a body that ends without returning',
		source: '/* @inline */ function find(xs) { for (const x of xs) if (x > 1) return x; } function run() { const ok = [1].length; return [[ok && find([0])]]; }',
	},
	{
		name: 'a pure body beside an arm that writes a compound target',
		source: 'let total = 1; function bump() { total += 10; return 1; } /* @inline @pure */ function any(items) { for (let i = 0; i < items.length; i++) if (items[i]) return true; return false; } function run() { total = 1; const flag = [].length; total += flag ? any([1]) : bump(); return total; }',
	},
	{
		name: 'a pure body under a test that writes a compound target',
		source: 'let total = 1; function bump() { total += 10; return 1; } /* @inline @pure */ function any(items) { for (let i = 0; i < items.length; i++) if (items[i]) return true; return false; } function run() { total = 1; total += bump() ? any([1]) : 0; return total; }',
	},
	{
		name: 'a pure body under a test that swaps the callee',
		source: '/* @inline @pure */ function any(items) { for (let i = 0; i < items.length; i++) if (items[i]) return true; return false; } function run() { let f = (x) => x; function swap() { f = (x) => [x]; return 1; } return f(swap() ? any([1]) : 0); }',
	},
	{
		name: 'a pure body beside an arm that swaps the method',
		source: '/* @inline @pure */ function any(items) { for (let i = 0; i < items.length; i++) if (items[i]) return true; return false; } function run() { const o = { m: (x) => x, swap() { this.m = (x) => [x]; return 1; } }; const flag = [].length; return o.m(flag ? any([1]) : o.swap()); }',
	},
	{
		name: 'a nullish assignment that is already set',
		source: 'let hits = 0; /* @inline */ function build(n) { for (let i = 0; i < n; i++) hits++; return hits; } function run() { hits = 0; let cache = 5; cache ??= build(3); return [cache, hits]; }',
	},
	{
		name: 'a branch inside an or assignment that is already set',
		source: 'let hits = 0; /* @inline */ function build(n) { for (let i = 0; i < n; i++) hits++; return hits; } function run() { hits = 0; let cache = 5; const c = [1].length; cache ||= c ? build(3) : 0; return [cache, hits]; }',
	},
	{
		name: 'a test with effects inside an and assignment that is unset',
		source: '/* @inline @pure */ function any(items) { for (let i = 0; i < items.length; i++) if (items[i]) return true; return false; } function run() { let n = 0; let cache = 0; cache &&= n++ ? any([1]) : 0; return [cache, n]; }',
	},
	{
		name: 'argument effects inside an or assignment that is already set',
		source: '/* @inline @pure */ function any(items) { for (let i = 0; i < items.length; i++) if (items[i]) return true; return false; } function run() { let n = 0; let cache = 1; cache ||= any([n++]); return [cache, n]; }',
	},
	{
		name: 'a compound assignment whose target the body writes',
		source: 'let total = 1; /* @inline */ function any(n) { for (let i = 0; i < n; i++) total += 10; return 1; } function run() { total = 1; total += any(1); return total; }',
	},
	{
		name: 'a compound assignment in a loop test beside a writer',
		source: 'let total = 1; function bump() { total += 10; return 1; } /* @inline */ function any(n) { let s = 0; for (let i = 0; i < n; i++) s += i; return s; } function run() { total = 1; let n = 0; while ((total += bump() + any(2)) < 30 && n++ < 5) {} return [total, n]; }',
	},
	{
		name: 'a compound assignment reached through an opened loop test',
		source: 'let total = 1; /* @inline */ function ready(q) { for (const v of q) if (v) return true; return false; } /* @inline */ function grow(n) { for (let i = 0; i < n; i++) total += 10; return 1; } function run() { total = 1; let n = 0; while (ready([1]) && (total += grow(1)) < 40 && n++ < 9) {} return [total, n]; }',
	},
	{
		name: 'a callee swapped by an earlier argument of a pure call',
		source: "/* @inline @pure */ function pur(x) { let s = 0; for (let i = 0; i < 2; i++) s += x; if (s > 2) return s; return 0; } function run() { let g = (a, b) => [a, b, 'g']; function M() { g = (a, b) => [b, a, 'G']; return 1; } const y = g(M(), pur(2)); return y; }",
	},
	{
		name: 'a callee swapped by the body',
		source: 'let f = (x) => x; /* @inline */ function swap(xs) { for (const x of xs) f = (y) => [y, x]; return 1; } function run() { f = (x) => x; return f(swap([1])); }',
	},
];

describe('branch positions', () => {
	it.each(orderCases)('keeps the order of $name', async ({ source }) => {
		const result = await compareBuilds({
			'main.js': `${source}
export {run};`,
		});
		expect(result.code).not.toContain('(() => {');
	});

	it('expands a body into a compound assignment to a variable only the caller can write', async () => {
		const result = await compareBuilds(
			{
				'main.js': `${any} export function run() { let total = 1; total += any([0, 1]) ? 2 : 0; total += [1].length ? any([1]) : 0; return total; }`,
			},
			'any'
		);
		expect(result.code).not.toContain('(() => {');
	});

	it.each(flattenedCases)('flattens $name', async ({ source, inlined }) => {
		const result = await compareBuilds(
			{ 'main.js': `${source}\nexport {run};` },
			inlined ?? 'any'
		);
		expect(result.code).not.toContain('(() => {');
	});

	it.each(keptCases)('keeps the call at $name', async ({ source }) => {
		const result = await compareBuilds({ 'main.js': `${source}\nexport {run};` });
		expect(result.code).toMatch(/(?<!function )\bany\s*\(/);
		expect(result.code).not.toContain('(() => {');
	});

	it('returns from each path of a returned branch without a result variable', async () => {
		const result = await compareBuilds(
			{
				'main.js': `${any} function pick(c, xs) { return c ? xs.length : any(xs); } export function run() { return [pick(1, [1]), pick(0, [1])]; }`,
			},
			'any'
		);
		const caller = result.code.slice(result.code.indexOf('function pick('));
		expect(caller).not.toContain('_result');
		expect(caller).not.toContain('_inline');
		expect(caller).not.toContain('_branch');
	});

	it('assigns a declared variable directly on each path', async () => {
		const result = await compareBuilds(
			{
				'main.js': `${any} export function run() { const log = []; const value = log.push(1) && any([0, 1]); return [value, log]; }`,
			},
			'any'
		);
		const caller = result.code.slice(result.code.indexOf('function run('));
		expect(caller).not.toContain('_result');
		expect(caller).not.toContain('_branch');
	});

	it('nests an and that guards a lone consequent', async () => {
		const result = await compareBuilds(
			{
				'main.js': `${any} function kind(a, xs) { if (a && any(xs)) { return "any"; } return "none"; } export function run() { return [kind(1, [1]), kind(1, [0]), kind(0, [1])]; }`,
			},
			'any'
		);
		expect(result.code.slice(result.code.indexOf('function kind('))).not.toContain('_branch');
	});
});

const moduleCases: { name: string; files: Record<string, string> }[] = [
	{
		name: 'same function names in different modules resolve independently',
		files: {
			'a.js': 'export /* @inline */ function helper(x) { return x + 1; }',
			'b.js': 'export /* @inline */ function helper(x) { return x + 10; }',
			'use-a.js': "import {helper} from './a.js'; export function a() { return helper(1); }",
			'use-b.js': "import {helper} from './b.js'; export function b() { return helper(1); }",
			'main.js':
				"import {a} from './use-a.js'; import {b} from './use-b.js'; export function run() { return [a(), b()]; }",
		},
	},
	{
		name: 'import aliases and default exports resolve through re-exports',
		files: {
			'lib.js':
				'export /* @inline */ function add(x) { return x + 1; } export default /* @inline */ function twice(x) { return x * 2; }',
			'barrel.js': "export {add as plus, default as double} from './lib.js';",
			'main.js':
				"import {plus as first, double as second} from './barrel.js'; export function run() { return [first(2), second(3)]; }",
		},
	},
	{
		name: 'default, namespace and aliased dependency imports retain their kind',
		files: {
			'dep.js': 'export default function triple(x) { return x * 3; } export const value = 2;',
			'lib.js':
				"import triple from './dep.js'; import * as ns from './dep.js'; import {value as offset} from './dep.js'; export /* @inline */ function calculate(x) { return triple(x) + ns.value + offset; }",
			'main.js':
				"import {calculate} from './lib.js'; export function run() { const triple = 100; const ns = 200; const offset = 300; return [calculate(2), triple, ns, offset]; }",
		},
	},
	{
		name: 'remaining function references keep their import',
		files: {
			'lib.js': 'export /* @inline */ function add(x) { return x + 1; }',
			'main.js':
				"import {add} from './lib.js'; export function run() { const alias = add; return [add(1), alias(2)]; }",
		},
	},
	{
		name: 'inlining retains module initialization',
		files: {
			'lib.js':
				'globalThis.effects = (globalThis.effects || 0) + 1; export /* @inline */ function add(x) { return x + 1; }',
			'main.js':
				"import {add} from './lib.js'; export function run() { return [add(1), globalThis.effects || 0]; }",
		},
	},
	{
		name: 'private module closures keep their original call',
		files: {
			'lib.js':
				'const base = 10; function helper(x) { return x * 2; } export /* @inline */ function calculate(x) { return helper(x) + base; }',
			'main.js':
				"import {calculate} from './lib.js'; export function run() { return calculate(2); }",
		},
	},
	{
		name: 'callee globals are not captured by caller locals',
		files: {
			'lib.js': 'export /* @inline */ function read() { return Math.PI; }',
			'main.js':
				"import {read} from './lib.js'; export function run() { const Math = {PI: 1}; return read(); }",
		},
	},
	{
		name: 'identical source text in different directories keeps its module context',
		files: {
			'a/dep.js': 'export const value = 1;',
			'b/dep.js': 'export const value = 2;',
			'a/lib.js':
				"import {value} from './dep.js'; export /* @inline */ function read() { return value; }",
			'b/lib.js':
				"import {value} from './dep.js'; export /* @inline */ function read() { return value; }",
			'a/use.js': "import {read} from './lib.js'; export function get() { return read(); }",
			'b/use.js': "import {read} from './lib.js'; export function get() { return read(); }",
			'main.js':
				"import {get as a} from './a/use.js'; import {get as b} from './b/use.js'; export function run() { return [a(), b()]; }",
		},
	},
	{
		name: 'pure hints follow the binding instead of shadowed names',
		files: {
			'lib.js': 'export /* @pure */ function effect() { return 1; }',
			'main.js':
				"import './lib.js'; export function run() { const log = []; function caller(effect) { effect(); } caller(() => log.push('called')); return log; }",
		},
	},
];

describe('module bindings', () => {
	it.each(moduleCases)('$name', async ({ files }) => {
		await compareBuilds(files);
	});
});

it.each([
	["import * as vector from './vec.js';", 'vector.scale'],
	["import {vec as vector} from './index.js';", 'vector.scale'],
	["import * as math from './index.js';", 'math.vec["scale"]'],
	["import {vectors as vector} from './alias.js';", 'vector.scale'],
])('inlines namespace math chains: %s', async (imports, call) => {
	const result = await compareBuilds(
		{
			'vec.js': `export /* @inline */ function scale(out, input, factor) {
			out[0] = input[0] * factor; out[1] = input[1] * factor;
		}`,
			'core.js': "export * as vec from './vec.js';",
			'index.js': "export * from './core.js';",
			'alias.js': "import {vec as value} from './index.js'; export {value as vectors};",
			'main.js': `${imports} export function run() {
			const scratch = [0, 0]; const out = [0, 0];
			${call}(scratch, [3, 4], 2); ${call}(out, scratch, 3);
			return out;
		}`,
		},
		'scale'
	);
	expect(result.value).toEqual([18, 24]);
});

it('resolves namespaces injected by nested inlining and concise arrows', async () => {
	const result = await compareBuilds(
		{
			'vec.js': 'export /* @inline */ function twice(x) { return x * 2; }',
			'lib.js':
				"import * as vec from './vec.js'; export /* @inline */ function calculate(x) { return vec.twice(x) + 1; }",
			'main.js': "import * as lib from './lib.js'; export const run = () => lib.calculate(3);",
		},
		'twice'
	);
	expect(result.value).toBe(7);
	expect(result.code).not.toMatch(/(?<!function )\bcalculate\s*\(/);
});

it('preserves namespace receivers, dynamic keys, mutable exports and shadowing', async () => {
	await compareBuilds({
		'vec.js': `export const offset = 4;
			export /* @inline */ function read() { return this?.offset ?? -1; }
			export /* @inline */ function twice(x) { return x * 2; }
			export /* @inline */ let live = (x) => x;
			export function replace() { live = (x) => x + 10; }`,
		'main.js': `import * as vec from './vec.js'; export function run() {
			const log = []; function key() { log.push('key'); return 'twice'; }
			function shadow(vec) { return vec.twice(3); }
			const before = vec.live(1); vec.replace();
			return [vec.read(), vec[key()](3), shadow({twice: x => x + 1}), before, vec.live(1), log];
		}`,
	});
});

it('erases cloned TypeScript annotations when the caller is JavaScript', async () => {
	await compareBuilds(
		{
			'lib.ts':
				'export /* @inline */ function read(value: {x?: number}): number { const result: number = value.x!; return result as number; }',
			'main.js':
				"import {read} from './lib.ts'; export function run() { return read({x: 3}); }",
		},
		'read'
	);
});

it('does not inline a reassigned named default export', async () => {
	await compareBuilds({
		'lib.js': 'export default /* @inline */ function read() { return 1; } read = () => 2;',
		'main.js': "import read from './lib.js'; export function run() { return read(); }",
	});
});

it('does not mistake exported function parameters for exported module bindings', async () => {
	await compareBuilds({
		'lib.js':
			'const hidden = 2; export function other(hidden) { return hidden; } export /* @inline */ function read() { return hidden; }',
		'main.js': "import {read} from './lib.js'; export function run() { return read(); }",
	});
});

it('preserves argument effects when an unused pure call needs an expression wrapper', async () => {
	await compareBuilds(
		{
			'main.js':
				'/* @inline @pure */ function identity(x) { return x; } export function run() { let count = 0; true && identity(++count); return count; }',
		},
		'identity'
	);
});

it('preserves argument effects when an outer pure call is removed', async () => {
	await compareBuilds(
		{
			'main.js':
				'/* @pure */ function discard(x) {} /* @inline @pure */ function identity(x) { return x; } export function run() { let count = 0; discard(identity(++count)); return count; }',
		},
		'identity'
	);
});

it('preserves special var assignments that share a catch parameter name', async () => {
	await compareBuilds({
		'main.js':
			'/* @inline */ function read() { try { throw 1; } catch (value) { var value = 2; } return value; } export function run() { return typeof read(); }',
	});
});

it('does not rebind a dependency to a different installed package version', async () => {
	await compareBuilds({
		'lib/node_modules/shared/package.json': '{"name":"shared","main":"index.js"}',
		'lib/node_modules/shared/index.js': 'export default x => x + 10;',
		'node_modules/shared/package.json': '{"name":"shared","main":"index.js"}',
		'node_modules/shared/index.js': 'export default x => x + 100;',
		'lib/api.js':
			"import value from 'shared'; export /* @inline */ function read(x) { return value(x); }",
		'main.js': "import {read} from './lib/api.js'; export function run() { return read(1); }",
	});
});

it('keeps nested return labels unique when injected imports rebuild scopes', async () => {
	await compareBuilds(
		{
			'dep.js': 'export const step = 1;',
			'lib.js':
				"import {step} from './dep.js'; export /* @inline */ function inner(x) { if (x < 0) return 0; return x + step; } export /* @inline */ function outer(x) { const first = inner(x); return inner(first); }",
			'main.js':
				"import {outer} from './lib.js'; export function run() { return [outer(1), outer(-2)]; }",
		},
		'outer'
	);
});

it('avoids source labels on ancestor blocks when generating return labels', async () => {
	await compareBuilds(
		{
			'main.js':
				'/* @inline */ function choose(value) { if (value) return 1; return 2; } export function run() { _inline: { return choose(true); } }',
		},
		'choose'
	);
});

it('substitutes parameters after removing nested TypeScript assertions', async () => {
	await compareBuilds(
		{
			'lib.ts':
				'export /* @inline */ function isValue(value: unknown): value is {x: boolean} { return (value as {x?: boolean} | null)?.x as unknown as boolean; }',
			'main.js':
				"import {isValue} from './lib.ts'; export function run() { const first = {x: true}; const second = null; return [isValue(first), isValue(second)]; }",
		},
		'isValue'
	);
});

it('reserves invocation temporaries while registering dependency imports', async () => {
	await compareBuilds(
		{
			'dep.js': 'export const step = 2;',
			'lib.js':
				"import {step} from './dep.js'; export /* @inline */ function calculate(arg) { const result = arg + step; return result; }",
			'main.js':
				"import {calculate} from './lib.js'; export function run() { return calculate(3); }",
		},
		'calculate'
	);
});

it('uses an expression instead of an invocation frame for tiny arrow helpers', async () => {
	const result = await compareBuilds({
		'lib.ts': 'export const getEntityId = /* @inline */ (entity: number) => entity & 0xffffff;',
		'main.js':
			"import {getEntityId} from './lib.ts'; export function run() { const entity = 0x1000003; return getEntityId(entity); }",
	});
	const caller = result.code.slice(result.code.indexOf('function run('));
	expect(caller).toContain('& 16777215');
	expect(caller).not.toContain('_inline');
	expect(caller).not.toContain('_result');
});

it.each(['var', 'let', 'const'])(
	'preserves native failure before a %s arrow is initialized',
	async (kind) => {
		await compareBuilds({
			'main.js': `export function run() { const value = 3; try { return helper(value); } catch (error) { return error.name; } ${kind} helper = /* @inline */ (value) => value + 1; }`,
		});
	}
);

it.each([
	[
		'one evaluation',
		'function read(value) { return value & 255; }',
		'let count = 1; const result = read(++count); return [result, count];',
	],
	[
		'unbound method receiver',
		'function read(value) { return value(); }',
		'const object = {method() { return this === undefined; }}; return read(object.method);',
	],
	[
		'anonymous function names',
		'function read(value) { return value.name; }',
		'return read(() => 1);',
	],
	[
		'indirect eval',
		'function read(value) { return value("typeof local"); }',
		'const local = 1; return read(eval);',
	],
	[
		'free bindings after argument effects',
		'function read(value) { return value + offset; }',
		'return read((offset = 5, 2));',
	],
	[
		'optional access',
		'function read(value) { return value?.x; }',
		'let count = 0; const result = read((++count, null)); return [result, count];',
	],
	[
		'typeof still evaluates the input',
		'function read(value) { return typeof value; }',
		'try { return read(missing); } catch (error) { return error.name; }',
	],
])('inlines a leading single-use input while preserving %s', async (_name, declaration, caller) => {
	const result = await compareBuilds(
		{
			'main.js': `let offset = 1; /* @inline */ ${declaration} export function run() { ${caller} }`,
		},
		'read'
	);
	expect(result.code.slice(result.code.indexOf('function run('))).not.toContain('_inline');
});

it('keeps argument capture when the parameter is evaluated after other operations', async () => {
	const result = await compareBuilds(
		{
			'main.js':
				'const log = []; function before() { log.push("body"); return 1; } /* @inline */ function read(value) { return before() + value; } export function run() { const value = read((log.push("arg"), 2)); return [value, log]; }',
		},
		'read'
	);
	const caller = result.code.slice(result.code.indexOf('function run('));
	expect(caller).not.toContain('=>');
	expect(caller.indexOf('log.push("arg")')).toBeLessThan(caller.indexOf('before()'));
});

it('substitutes a leading data read when the remaining inputs are stable', async () => {
	const result = await compareBuilds(
		{
			'lib.ts':
				'export /* @inline */ function getInstance(data: Record<string, number>, trait: {id: string}) { return data[trait.id]; }',
			'main.js':
				"import {getInstance} from './lib.ts'; export function run() { let count = 0; const trait = {id: 'value'}; const context = {get data() { count++; return {value: 3}; }}; const value = getInstance(context.data, trait); return [value, count]; }",
		},
		'getInstance'
	);
	expect(result.code.slice(result.code.indexOf('function run('))).not.toContain('_inline');
});

it('captures all arguments before body getters when a later input has effects', async () => {
	await compareBuilds(
		{
			'main.js':
				'const log = []; /* @inline */ function read(data, key) { return data[key.id]; } export function run() { const data = {get x() { log.push("body"); return 3; }}; const value = read((log.push("first"), data), (log.push("second"), {id: "x"})); return [value, log]; }',
		},
		'read'
	);
});

it('reuses initialized immutable parameter snapshots at nested inline sites', async () => {
	const result = await compareBuilds(
		{
			'lib.js':
				'export /* @inline */ function getInstance(data, trait) { return data[trait.id]; } export /* @inline */ function outer(context, trait) { const value = getInstance(context.data, trait); return value + 1; }',
			'main.js':
				"import {outer} from './lib.js'; export function run() { const context = {data: {x: 3}}; const trait = {id: 'x'}; return outer(context, trait); }",
		},
		'outer'
	);
	const caller = result.code.slice(result.code.indexOf('function run('));
	expect(caller).not.toContain('_result');
	expect(caller).not.toContain('_inline');
	expect(caller.match(/\bconst _\w+ = /g)).toHaveLength(1);
	expect(caller).toContain('context.data');
});

it('resolves injected dependency imports relative to the caller module', async () => {
	await compareBuilds(
		{
			'shared/leaf.js': 'export /* @inline */ function leaf(value) { return value + 1; }',
			'nested/lib/shared/leaf.js':
				'export /* @inline */ function leaf(value) { return value + 100; }',
			'nested/lib/outer.js':
				"import {leaf} from '../../shared/leaf.js'; export /* @inline */ function outer(value) { const result = leaf(value); return result; }",
			'main.js':
				"import {outer} from './nested/lib/outer.js'; export function run() { return outer(2); }",
		},
		'outer'
	);
});
