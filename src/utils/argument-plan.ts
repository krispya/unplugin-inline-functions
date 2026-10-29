import { Binding } from '@babel/traverse';
import * as t from '@babel/types';

/**
 * Walk a body in evaluation order, recording parameter reads, until the first operation
 * that could run user code or branch. Returns false once that operation is reached.
 */
function createWalker(names: Set<string>, reads: string[], nested: Set<string>) {
	function all(nodes: (t.Node | null | undefined)[]): boolean {
		for (const node of nodes) if (node && !walk(node)) return false;
		return true;
	}
	function walk(node: t.Node): boolean {
		if (t.isIdentifier(node)) {
			if (names.has(node.name)) reads.push(node.name);
			return true;
		}
		if (t.isLiteral(node) && !t.isTemplateLiteral(node)) return true;
		if (t.isThisExpression(node)) return true;
		if (t.isFunction(node) || t.isClass(node)) {
			t.traverseFast(node, (child) => {
				if (t.isIdentifier(child) && names.has(child.name)) nested.add(child.name);
			});
			return true;
		}
		if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
			return all([node.object, node.computed ? node.property : null]) && false;
		if (t.isCallExpression(node) || t.isNewExpression(node) || t.isOptionalCallExpression(node))
			return all([node.callee, ...node.arguments]) && false;
		if (t.isUnaryExpression(node))
			return walk(node.argument) && ['!', 'void', 'typeof'].includes(node.operator);
		if (t.isBinaryExpression(node))
			return all([node.left, node.right]) && ['===', '!=='].includes(node.operator);
		if (t.isLogicalExpression(node) || t.isConditionalExpression(node))
			return walk(t.isLogicalExpression(node) ? node.left : node.test) && false;
		if (t.isSequenceExpression(node)) return all(node.expressions);
		if (t.isAssignmentExpression(node))
			return (
				all([t.isMemberExpression(node.left) ? node.left.object : null, node.right]) && false
			);
		if (t.isUpdateExpression(node) || t.isAwaitExpression(node) || t.isYieldExpression(node))
			return all([node.argument]) && false;
		if (t.isSpreadElement(node)) return walk(node.argument) && false;
		if (t.isArrayExpression(node)) return all(node.elements);
		if (t.isObjectExpression(node)) {
			for (const property of node.properties) {
				if (t.isObjectMethod(property)) continue;
				if (t.isSpreadElement(property)) return walk(property.argument) && false;
				if (property.computed && !walk(property.key)) return false;
				if (!walk(property.value)) return false;
			}
			return true;
		}
		if (t.isTemplateLiteral(node)) return all(node.expressions.slice(0, 1)) && false;
		if (
			t.isTSAsExpression(node) ||
			t.isTSNonNullExpression(node) ||
			t.isTSSatisfiesExpression(node) ||
			t.isTSTypeAssertion(node) ||
			t.isParenthesizedExpression(node)
		)
			return walk(node.expression);
		return false;
	}
	return function statements(list: t.Statement[]) {
		for (const statement of list) {
			if (t.isVariableDeclaration(statement)) {
				for (const declaration of statement.declarations) {
					if (declaration.init && !walk(declaration.init)) return;
					if (!t.isIdentifier(declaration.id)) return;
				}
			} else if (t.isExpressionStatement(statement)) {
				if (!walk(statement.expression)) return;
			} else {
				if (t.isReturnStatement(statement) || t.isThrowStatement(statement)) {
					if (statement.argument) walk(statement.argument);
				} else if (t.isIfStatement(statement)) walk(statement.test);
				return;
			}
		}
	};
}

/**
 * Parameters whose argument can be read at the parameter's single use instead of a
 * snapshot. Stable arguments qualify anywhere. Effectful arguments qualify as a suffix
 * of the parameter list when their uses lead the body, in parameter order, ahead of any
 * operation that could observe them.
 */
export function planSubstitutions(
	body: t.Statement[],
	params: t.Identifier[],
	bindings: Binding[],
	stable: boolean[],
	surplus: boolean
): Set<number> {
	const plan = new Set<number>();
	const names = new Set(params.map((param) => param.name));
	const reads: string[] = [];
	const nested = new Set<string>();
	createWalker(names, reads, nested)(body);
	const candidates = params.map((param, index) => {
		const binding = bindings[index];
		if (!binding.constant) return false;
		if (stable[index]) return true;
		if (surplus || nested.has(param.name) || binding.referencePaths.length !== 1) return false;
		return reads.filter((name) => name === param.name).length === 1;
	});
	const effectful = params.map((_, index) => index).filter((index) => !stable[index]);
	let start = effectful.length;
	while (start > 0) {
		const suffix = effectful.slice(start - 1);
		const order = suffix.map((index) => reads.indexOf(params[index].name));
		const ordered = order.every((position, at) => at === 0 || position > order[at - 1]);
		if (!candidates[suffix[0]] || !ordered) break;
		start--;
	}
	for (const index of effectful.slice(start)) plan.add(index);
	candidates.forEach((candidate, index) => {
		if (candidate && stable[index]) plan.add(index);
	});
	return plan;
}
