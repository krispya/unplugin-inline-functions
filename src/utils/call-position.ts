import { NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';

/** The statement containing an expression, unless a function or class boundary comes first. */
export function enclosingStatement(path: NodePath): NodePath<t.Statement> | undefined {
	let current: NodePath | null = path;
	while (current && !current.isStatement()) {
		if (current.isFunction() || current.isClass()) return;
		current = current.parentPath;
	}
	if (!current || current.isBlockStatement()) return;
	return current as NodePath<t.Statement>;
}

/** Insert statements ahead of a statement. A for loop head takes them ahead of the loop. */
export function insertBeforeStatement(statement: NodePath<t.Statement>, nodes: t.Statement[]) {
	const target =
		statement.parentPath?.isForStatement() && statement.key === 'init'
			? statement.parentPath
			: statement;
	return target.insertBefore(nodes);
}

/** A callee a pure body cannot change between hoisted evaluation and the call. */
function stableCallee(callee: t.Node) {
	if (t.isIdentifier(callee)) return true;
	return (
		t.isMemberExpression(callee) &&
		!callee.computed &&
		(t.isIdentifier(callee.object) || t.isThisExpression(callee.object))
	);
}

/** A callee read whose value cannot change while a body runs ahead of the call. */
function fixedCallee(callee: t.Node, scope: Scope, pure: boolean) {
	if (t.isIdentifier(callee)) {
		if (pure) return true;
		const binding = scope.getBinding(callee.name);
		return Boolean(binding?.constant);
	}
	return pure && stableCallee(callee);
}

export interface Hoist {
	anchor: NodePath<t.Statement>;
	/** Operands evaluated before the call, in order, that must run before its body. */
	spills: NodePath<t.Expression>[];
}

/**
 * Operands of a parent that evaluate before a child, when the child is evaluated on
 * every path through the parent. Undefined marks a conditional or unsupported position.
 */
function precedingOperands(
	child: NodePath,
	pure: boolean
): (t.Node | null | undefined)[] | undefined {
	const parent = child.parentPath!;
	const key = child.key;
	if (parent.isExpressionStatement() || parent.isReturnStatement() || parent.isThrowStatement())
		return [];
	if (parent.isIfStatement()) return key === 'test' ? [] : undefined;
	if (parent.isSwitchStatement()) return key === 'discriminant' ? [] : undefined;
	if (parent.isForStatement()) return key === 'init' ? [] : undefined;
	if (parent.isForOfStatement() || parent.isForInStatement())
		return key === 'right' ? [] : undefined;
	if (parent.isVariableDeclarator()) return key === 'init' && parent.key === 0 ? [] : undefined;
	if (parent.isVariableDeclaration()) return key === 0 ? [] : undefined;
	if (parent.isUnaryExpression()) return parent.node.operator === 'delete' ? undefined : [];
	if (parent.isAwaitExpression() || parent.isSpreadElement()) return [];
	if (parent.isBinaryExpression())
		return key === 'left'
			? []
			: t.isExpression(parent.node.left)
				? [parent.node.left]
				: undefined;
	if (parent.isLogicalExpression()) return key === 'left' ? [] : undefined;
	if (parent.isConditionalExpression()) return key === 'test' ? [] : undefined;
	if (parent.isSequenceExpression()) return parent.node.expressions.slice(0, key as number);
	if (parent.isMemberExpression() || parent.isOptionalMemberExpression()) {
		if (key === 'object') return [];
		return parent.node.computed && !parent.isOptionalMemberExpression()
			? [parent.node.object]
			: undefined;
	}
	if (parent.isCallExpression() || parent.isNewExpression()) {
		if (key === 'callee') return [];
		if (!fixedCallee(parent.node.callee, parent.scope, pure)) return undefined;
		return parent.node.arguments.slice(0, key as number);
	}
	if (parent.isArrayExpression()) return parent.node.elements.slice(0, key as number);
	if (parent.isObjectProperty() && key === 'value' && !parent.node.computed) {
		const object = parent.parentPath;
		if (!object.isObjectExpression()) return undefined;
		const earlier = object.node.properties.slice(0, parent.key as number);
		if (!earlier.every((property) => t.isObjectProperty(property) && !property.computed))
			return undefined;
		return earlier.map((property) => (property as t.ObjectProperty).value);
	}
	if (parent.isAssignmentExpression() && key === 'right') {
		if (t.isIdentifier(parent.node.left)) return [];
		if (t.isMemberExpression(parent.node.left))
			return parent.node.left.computed
				? [parent.node.left.object, parent.node.left.property]
				: [parent.node.left.object];
		return undefined;
	}
	if (parent.isTemplateLiteral()) return key === 0 ? [] : undefined;
	if (
		parent.isTSAsExpression() ||
		parent.isTSNonNullExpression() ||
		parent.isTSSatisfiesExpression() ||
		parent.isTSTypeAssertion() ||
		parent.isParenthesizedExpression()
	)
		return [];
	return undefined;
}

/** A value that can stay in place while a body runs ahead of it. */
function fixedOperand(node: t.Node, stable: (node: t.Expression) => boolean) {
	if (t.isLiteral(node) && !t.isTemplateLiteral(node)) return true;
	if (t.isThisExpression(node) || t.isFunction(node)) return true;
	if (t.isUnaryExpression(node, { operator: 'void' })) return fixedOperand(node.argument, stable);
	return t.isExpression(node) && stable(node);
}

/**
 * The statement a call's expansion can precede, with the operands that must be
 * evaluated into temporaries first so that nothing is reordered or repeated.
 */
export function hoistAnchor(
	call: NodePath<t.CallExpression>,
	pure: boolean,
	stable: (node: t.Expression) => boolean
): Hoist | undefined {
	const levels: NodePath<t.Expression>[][] = [];
	let current: NodePath = call;
	while (current.parentPath) {
		const operands = precedingOperands(current, pure);
		if (!operands) return;
		const parent = current.parentPath;
		const spills: NodePath<t.Expression>[] = [];
		for (const operand of operands) {
			if (!operand || fixedOperand(operand, stable)) continue;
			if (t.isSpreadElement(operand) || t.isArgumentPlaceholder(operand)) return;
			if (!t.isExpression(operand)) return;
			const path = findChild(parent, operand);
			if (!path) return;
			spills.push(path);
		}
		levels.push(spills);
		if (parent.isStatement())
			return { anchor: parent as NodePath<t.Statement>, spills: levels.reverse().flat() };
		current = parent;
	}
	return;
}

function findChild(parent: NodePath, node: t.Node): NodePath<t.Expression> | undefined {
	let found: NodePath<t.Expression> | undefined;
	for (const key of t.VISITOR_KEYS[parent.node.type]) {
		const value = (parent.node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			const index = value.indexOf(node);
			if (index >= 0) found = parent.get(`${key}.${index}`) as NodePath<t.Expression>;
		} else if (value === node) found = parent.get(key) as NodePath<t.Expression>;
		if (found) return found;
	}
	return;
}
