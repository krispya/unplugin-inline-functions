import { parseExpression } from '@babel/parser';
import _traverse, { Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { exportedConstant, resolveSource } from '../collect-metadata';
import { getBabelDefaultExport } from './babel-exports';

const traverse = getBabelDefaultExport(_traverse);

export type Constant = { value: string | number | boolean | null | undefined };

/** Parse bundler style define values, such as `'false'` or `'"production"'`, into constants. */
export function parseDefines(define: Record<string, string>): Map<string, Constant> {
	const constants = new Map<string, Constant>();
	for (const [name, source] of Object.entries(define)) {
		try {
			const constant = evaluate(parseExpression(source), () => undefined);
			if (constant) constants.set(name, constant);
		} catch {
			// Values that are not expressions never fold.
		}
	}
	return constants;
}

function dotted(node: t.Node): string | undefined {
	if (t.isIdentifier(node)) return node.name;
	if (t.isMemberExpression(node) && !node.computed && t.isIdentifier(node.property)) {
		const object = dotted(node.object);
		return object && `${object}.${node.property.name}`;
	}
	return undefined;
}

/** Fold an expression made of literals and resolvable names to one value. */
export function evaluate(
	node: t.Node,
	resolve: (name: string) => Constant | undefined
): Constant | undefined {
	if (t.isStringLiteral(node) || t.isNumericLiteral(node) || t.isBooleanLiteral(node))
		return { value: node.value };
	if (t.isNullLiteral(node)) return { value: null };
	if (t.isIdentifier(node) || t.isMemberExpression(node)) {
		const name = dotted(node);
		if (!name) return;
		const resolved = resolve(name);
		if (resolved) return resolved;
		return name === 'undefined' ? { value: undefined } : undefined;
	}
	if (
		t.isParenthesizedExpression(node) ||
		t.isTSAsExpression(node) ||
		t.isTSNonNullExpression(node) ||
		t.isTSSatisfiesExpression(node) ||
		t.isTSTypeAssertion(node)
	)
		return evaluate(node.expression, resolve);
	if (t.isUnaryExpression(node)) {
		if (node.operator === 'typeof') {
			const name = dotted(node.argument);
			const resolved = name ? resolve(name) : evaluate(node.argument, resolve);
			if (resolved) return { value: typeof resolved.value };
			return name === 'undefined' ? { value: 'undefined' } : undefined;
		}
		const argument = evaluate(node.argument, resolve);
		if (!argument) return;
		const value = argument.value as number;
		switch (node.operator) {
			case '!':
				return { value: !value };
			case '-':
				return { value: -value };
			case '+':
				return { value: +value };
			case '~':
				return { value: ~value };
			case 'void':
				return { value: undefined };
		}
		return;
	}
	if (t.isBinaryExpression(node)) {
		const left = evaluate(node.left, resolve);
		const right = evaluate(node.right, resolve);
		if (!left || !right) return;
		const a = left.value as number;
		const b = right.value as number;
		switch (node.operator) {
			case '===':
				return { value: a === b };
			case '!==':
				return { value: a !== b };
			case '==':
				// eslint-disable-next-line eqeqeq
				return { value: a == b };
			case '!=':
				// eslint-disable-next-line eqeqeq
				return { value: a != b };
			case '<':
				return { value: a < b };
			case '>':
				return { value: a > b };
			case '<=':
				return { value: a <= b };
			case '>=':
				return { value: a >= b };
			case '+':
				return { value: (a as unknown as string) + (b as unknown as string) };
			case '-':
				return { value: a - b };
			case '*':
				return { value: a * b };
			case '/':
				return { value: a / b };
			case '%':
				return { value: a % b };
			case '&':
				return { value: a & b };
			case '|':
				return { value: a | b };
			case '^':
				return { value: a ^ b };
			case '<<':
				return { value: a << b };
			case '>>':
				return { value: a >> b };
			case '>>>':
				return { value: a >>> b };
		}
		return;
	}
	if (t.isLogicalExpression(node)) {
		const left = evaluate(node.left, resolve);
		if (!left) return;
		const value = left.value;
		if (node.operator === '&&') return value ? evaluate(node.right, resolve) : left;
		if (node.operator === '||') return value ? left : evaluate(node.right, resolve);
		return value === null || value === undefined ? evaluate(node.right, resolve) : left;
	}
	if (t.isConditionalExpression(node)) {
		const test = evaluate(node.test, resolve);
		if (!test) return;
		return evaluate(test.value ? node.consequent : node.alternate, resolve);
	}
	if (t.isSequenceExpression(node)) {
		const values = node.expressions.map((expression) => evaluate(expression, resolve));
		return values.every(Boolean) ? values[values.length - 1] : undefined;
	}
	return;
}

/** Resolve a name within a scope: a define, a constant binding, or an imported constant. */
export function createResolver(defines: Map<string, Constant>) {
	const visiting = new Set<t.Node>();
	function resolver(scope: Scope): (name: string) => Constant | undefined {
		return (name) => {
			const defined = defines.get(name);
			if (defined) return defined;
			if (name.includes('.')) return;
			const binding = scope.getBinding(name);
			if (!binding?.constant) return;
			let init: { node: t.Expression; scope: Scope } | undefined;
			if (
				binding.kind === 'const' &&
				binding.path.isVariableDeclarator() &&
				binding.path.node.init
			)
				init = { node: binding.path.node.init, scope: binding.path.scope };
			else if (binding.kind === 'module' && binding.path.isImportSpecifier()) {
				const declaration = binding.path.parentPath;
				const importer = binding.path.node.loc?.filename;
				if (!declaration.isImportDeclaration() || !importer) return;
				const source = resolveSource(declaration.node.source.value, importer);
				const imported = binding.path.node.imported;
				const exported = t.isIdentifier(imported) ? imported.name : imported.value;
				const target = source && exportedConstant(source, exported);
				if (target) init = { node: target.init, scope: target.scope };
			}
			if (!init || visiting.has(init.node)) return;
			visiting.add(init.node);
			try {
				return evaluate(init.node, resolver(init.scope));
			} finally {
				visiting.delete(init.node);
			}
		};
	}
	return resolver;
}

/** Replace resolvable tests with their values and drop the branches they exclude. */
export function foldConstants(ast: t.File, defines: Map<string, Constant>) {
	const resolver = createResolver(defines);
	const literal = (constant: Constant) => t.valueToNode(constant.value) as t.Expression;
	traverse(ast, {
		IfStatement(path) {
			const test = evaluate(path.node.test, resolver(path.scope));
			if (!test) return;
			const branch = test.value ? path.node.consequent : path.node.alternate;
			if (branch) path.replaceWith(branch);
			else path.remove();
		},
		ConditionalExpression(path) {
			const test = evaluate(path.node.test, resolver(path.scope));
			if (test) path.replaceWith(test.value ? path.node.consequent : path.node.alternate);
		},
		LogicalExpression(path) {
			const left = evaluate(path.node.left, resolver(path.scope));
			if (!left) return;
			const short =
				path.node.operator === '&&'
					? !left.value
					: path.node.operator === '||'
						? Boolean(left.value)
						: left.value !== null && left.value !== undefined;
			path.replaceWith(short ? literal(left) : path.node.right);
		},
	});
}
