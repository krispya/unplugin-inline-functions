import { parse } from '@babel/parser';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { collectMetadata, resetMetadata } from '../src/collect-metadata';
import { inlineFunctions } from '../src/inline-functions';

function compile(source: string) {
	const ast = parse(source, { sourceFilename: '/test/scalar.ts', plugins: ['typescript'] });
	resetMetadata();
	collectMetadata(ast);
	return inlineFunctions(ast, { outlineThrows: false });
}

function execute(source: string) {
	return structuredClone(vm.runInNewContext(`${source}\nrun()`, {}, { timeout: 1000 }));
}

describe('scalar scratch tuples', () => {
	it('scalarizes create, fromValues and clone results in one declaration', () => {
		const source = `
			/* @inline */ function create() { return [0, 0, 0]; }
			/* @inline */ function fromValues(x, y, z) { return [x, y, z]; }
			/* @inline */ function clone(a) { return [a[0], a[1], a[2]]; }
			function run() {
				const seed = 3;
				const empty = create(), values = fromValues(seed, seed + 1, seed + 2), copy = clone(values);
				empty[0] = copy[0] * 2;
				copy[1] += values[2];
				return [empty[0], copy[1], copy[2]];
			}`;
		const code = compile(source);
		expect(code.slice(code.indexOf('function run('))).not.toMatch(/\b(empty|values|copy)\b/);
		expect(execute(code)).toEqual([6, 9, 5]);
		expect(execute(code)).toEqual(execute(source));
	});

	it('evaluates factory arguments and unused components once in their original order', () => {
		const source = `
			/* @inline */ function fromValues(x, y, z) { return [x, y, z]; }
			function run() {
				const log = []; function next(value) { log.push(value); return log.length; }
				const scratch = fromValues(next('x'), next('y'), next('z'));
				return [scratch[2], scratch[0], log];
			}`;
		const code = compile(source);
		expect(code.slice(code.indexOf('function run('))).not.toContain('scratch[');
		expect(execute(code)).toEqual([3, 1, ['x', 'y', 'z']]);
		expect(execute(code)).toEqual(execute(source));
	});

	it('preserves throwing reads of unused cloned components', () => {
		const source = `
			/* @inline */ function clone(a) { return [a[0], a[1], a[2]]; }
			function run() {
				const log = [];
				const input = {get 0() { log.push(0); return 1; }, get 1() { log.push(1); throw 2; }, get 2() { log.push(2); return 3; }};
				try { const scratch = clone(input); return scratch[0]; }
				catch (error) { return [log, error]; }
			}`;
		const code = compile(source);
		expect(code.slice(code.indexOf('function run('))).not.toContain('scratch[');
		expect(execute(code)).toEqual([[0, 1], 2]);
		expect(execute(code)).toEqual(execute(source));
	});

	it('preserves surplus argument effects before a fresh tuple initializer', () => {
		const source = `
			/* @inline */ function create() { return [0, 0]; }
			function run() {
				const log = [];
				const scratch = create(log.push('argument'));
				scratch[0] = 3;
				return [scratch[0], log];
			}`;
		const code = compile(source);
		expect(code.slice(code.indexOf('function run('))).not.toContain('scratch[');
		expect(execute(code)).toEqual([3, ['argument']]);
		expect(execute(code)).toEqual(execute(source));
	});

	it('recognizes TypeScript tuple assertions around an inlined factory', () => {
		const source = `/* @inline */ function fromValues(x, y) { return [x, y]; }
			function run() { const scratch = fromValues(2, 3) as [number, number]; return scratch[0] + scratch[1]; }`;
		const code = compile(source);
		expect(code.slice(code.indexOf('function run('))).not.toContain('scratch[');
		expect(execute(code)).toBe(5);
	});

	it('keeps anonymous function and class initializer names unchanged', () => {
		const source = `function run() {
			const log = [];
			/* @scalar */ const scratch = [function() {}, class { static { log.push(this.name); } }];
			return [scratch[0].name, scratch[1].name, log];
		}`;
		const code = compile(source);
		expect(code).not.toContain('scratch[');
		expect(execute(code)).toEqual(['', '', ['']]);
		expect(execute(code)).toEqual(execute(source));
	});

	it.each(["['use strict', 1]", "('use strict', [1])"])(
		'does not turn initializer strings into directives: %s',
		(initializer) => {
			const source = `function run() {
				/* @scalar */ const scratch = ${initializer};
				return this === undefined;
			}`;
			expect(execute(compile(source))).toEqual(execute(source));
		}
	);

	it('keeps remaining factory calls and returned shared storage intact', () => {
		const source = `const shared = [1, 2]; function create() { return shared; }
			function run() { /* @scalar */ const scratch = create(); scratch[0] = 4; return [scratch === shared, shared[0]]; }`;
		const code = compile(source);
		expect(code).toContain('const scratch = create()');
		expect(execute(code)).toEqual([true, 4]);
	});

	it.each(['[1, , 3]', '[...[1, 2, 3]]'])('retains unsupported initializer %s', (initializer) => {
		const source = `function run() { /* @scalar */ const scratch = ${initializer}; return scratch[0]; }`;
		const code = compile(source);
		expect(code).toContain('scratch[0]');
		expect(execute(code)).toEqual(execute(source));
	});

	it.each(['', '/* @scalar */'])(
		'removes scratch storage after inlining a numeric chain (%s)',
		(annotation) => {
			const source = `
			/* @inline */ function scale(out, a, factor) {
				out[0] = a[0] * factor;
				out[1] = a[1] * factor;
				out[2] = a[2] * factor;
				return out;
			}
			/* @inline */ function add(out, a, b) {
				out[0] = a[0] + b[0];
				out[1] = a[1] + b[1];
				out[2] = a[2] + b[2];
				return out;
			}
			function run() {
				${annotation} const scratch = [0, 0, 0];
				const input = [1.1, -2.2, 3.3], output = new Float32Array(3);
				for (let i = 0; i < 5; i++) {
					scale(scratch, input, i / 3);
					add(scratch, scratch, input);
					scale(output, scratch, 0.7);
				}
				return Array.from(output);
			}`;
			const code = compile(source);
			const caller = code.slice(code.indexOf('function run('));
			expect(caller).not.toMatch(/\bscratch\b/);
			expect(caller).not.toContain('[0, 0, 0]');
			expect(execute(code)).toEqual(execute(source));
		}
	);

	it('preserves component state across branches, updates and loop iterations', () => {
		const source = `function run() {
			/* @scalar */ const scratch = [-0, 2];
			const result = [Object.is(scratch[0], -0)];
			for (let i = 0; i < 4; i++) {
				if (i % 2) scratch[0] += scratch[1];
				else scratch[1]++;
				result.push(scratch[0], scratch[1]);
			}
			return result;
		}`;
		const code = compile(source);
		expect(code).not.toMatch(/\bscratch\[/);
		expect(execute(code)).toEqual(execute(source));
	});

	it('does not expose a directive when removing unused storage', () => {
		const source = `function run() {
			/* @scalar */ const scratch = [0];
			'use strict';
			return this === undefined;
		}`;
		expect(execute(compile(source))).toEqual(execute(source));
	});

	it('retains storage visible to direct eval through TypeScript wrappers', () => {
		const source = `function run() {
			/* @scalar */ const scratch = [3];
			return (eval as typeof eval)('scratch[0]');
		}`;
		const code = compile(source);
		expect(execute(transformSync(code, { loader: 'ts' }).code)).toBe(3);
	});

	it('retains the receiver through a TypeScript instantiation expression', () => {
		const source = `function run() {
			/* @scalar */ const scratch = [0, 7];
			function read<T>() { return this[1]; }
			scratch[0] = read;
			return (scratch[0]<number>)();
		}`;
		const code = compile(source);
		expect(execute(transformSync(code, { loader: 'ts' }).code)).toBe(7);
	});

	it('leaves unannotated arrays outside functions changed by inlining unchanged', () => {
		const code = compile(
			'function run() { const scratch = [0]; scratch[0] = 2; return scratch[0]; }'
		);
		expect(code).toContain('scratch[0]');
		expect(execute(code)).toBe(2);
	});

	it.each([
		[16, '', true],
		[17, '', false],
		[17, '/* @scalar */', true],
	] as const)(
		'limits automatic replacement to small tuples (%i components, %s)',
		(size, annotation, replaced) => {
			const source = `
			/* @inline */ function value() { return 7; }
			function run() {
				${annotation} const scratch = [${Array(size).fill(0).join(', ')}];
				scratch[${size - 1}] = value();
				return scratch[${size - 1}];
			}`;
			const code = compile(source);
			expect(code.includes('const scratch =')).toBe(!replaced);
			expect(execute(code)).toBe(7);
		}
	);

	it('retains an early reference error before assignment side effects', () => {
		const source = `function run() {
			const log = [];
			try {
				scratch[0] = log.push('rhs');
				/* @scalar */ const scratch = [0];
			} catch (error) { log.push(error.name); }
			return log;
		}`;
		const code = compile(source);
		expect(execute(code)).toEqual(['ReferenceError']);
		expect(execute(code)).toEqual(execute(source));
	});

	it.each([
		['returned identity', 'return scratch;'],
		['local alias', 'const alias = scratch; alias[0] = 3; return scratch[0];'],
		['uninlined call', 'function touch(a) { a[0] = 4; } touch(scratch); return scratch[0];'],
		['dynamic index', 'const index = 0; return scratch[index];'],
		['out of bounds', 'scratch[2] = 7; return scratch[2];'],
		['deletion', 'delete scratch[0]; return scratch[0];'],
		['closure capture', 'const read = () => scratch[0]; return read();'],
		['direct eval', 'return eval("scratch[0]");'],
		[
			'method receiver',
			'function read() { return this[1]; } scratch[0] = read; return scratch[0]();',
		],
		['function name inference', 'scratch[0] = () => 1; return scratch[0].name;'],
		['destructuring target', '[scratch[0] = () => 1] = []; return scratch[0].name;'],
	])('retains storage for %s', (_name, body) => {
		for (const annotation of ['', '/* @scalar */']) {
			const source = `/* @inline */ function tick() {} function run() {
				tick(); ${annotation} const scratch = [0, 2]; ${body}
			}`;
			const code = compile(source);
			expect(code).toContain('const scratch = [0, 2]');
			expect(execute(code)).toEqual(execute(source));
		}
	});

	it('retains typed arrays and their intermediate rounding', () => {
		const source = `function run() {
			/* @scalar */ const scratch = new Float32Array(1);
			scratch[0] = 1 / 3;
			return scratch[0] * 3;
		}`;
		const code = compile(source);
		expect(code).toContain('scratch[0]');
		expect(execute(code)).toEqual(execute(source));
		expect(execute(code)).not.toBe(1);
	});
});
