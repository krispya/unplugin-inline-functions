import { parse } from '@babel/parser';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { collectMetadata, resetMetadata } from '../src/collect-metadata';
import { inlineFunctions } from '../src/inline-functions';

function compile(source: string) {
	const ast = parse(source, { sourceFilename: '/test/scalar.js' });
	resetMetadata();
	collectMetadata(ast);
	return inlineFunctions(ast, { outlineThrows: false });
}

function execute(source: string) {
	return structuredClone(vm.runInNewContext(`${source}\nrun()`, {}, { timeout: 1000 }));
}

describe('scalar scratch tuples', () => {
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
