import { NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { reassignedImport, resolveCall } from '../collect-metadata';
import { loweredAssignments } from './lower-to-expression';

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

/** A wrapper that passes its operand's value through unchanged. */
export function transparent(path: NodePath) {
	return (
		path.isTSAsExpression() ||
		path.isTSNonNullExpression() ||
		path.isTSSatisfiesExpression() ||
		path.isTSTypeAssertion() ||
		path.isParenthesizedExpression()
	);
}

/** A value whose evaluation has no effect and cannot fail. */
export function constantValue(node: t.Node): boolean {
	if (t.isLiteral(node) && !t.isTemplateLiteral(node)) return true;
	return t.isUnaryExpression(node, { operator: 'void' }) && constantValue(node.argument);
}

/** Keep an anonymous function or class from taking the name of the variable that receives it. */
export function unnamed(value: t.Expression) {
	const anonymous =
		t.isArrowFunctionExpression(value) ||
		((t.isFunctionExpression(value) || t.isClassExpression(value)) && !value.id);
	return anonymous ? t.sequenceExpression([t.numericLiteral(0), value]) : value;
}

function effectful(path: NodePath) {
	// A call to a pure function only runs its arguments, which are visited on their own.
	if (path.isCallExpression()) return !resolveCall(path)?.pure;
	return (
		path.isOptionalCallExpression() ||
		path.isNewExpression() ||
		path.isTaggedTemplateExpression() ||
		// A lowered body writes only temporaries of its own.
		(path.isAssignmentExpression() && !loweredAssignments.has(path.node)) ||
		path.isUpdateExpression() ||
		path.isUnaryExpression({ operator: 'delete' }) ||
		path.isAwaitExpression() ||
		path.isYieldExpression()
	);
}

/** Whether evaluating an expression runs nothing that could write state or suspend. */
export function effectFree(path: NodePath) {
	let free = !effectful(path);
	if (free)
		path.traverse({
			enter(child) {
				if (!effectful(child)) return;
				free = false;
				child.stop();
			},
		});
	return free;
}

export function logicalAssignmentOperator(operator: string) {
	return operator === '&&=' || operator === '||=' || operator === '??=';
}

/** A reference that reads the same when evaluated a second time with nothing in between. */
export function repeatable(target: t.Node) {
	if (t.isIdentifier(target)) return true;
	return (
		t.isMemberExpression(target) &&
		(t.isIdentifier(target.object) || t.isThisExpression(target.object)) &&
		(!target.computed || t.isIdentifier(target.property) || constantValue(target.property))
	);
}

/** A callee read whose value cannot change while a body runs ahead of the call. */
function fixedCallee(callee: t.Node, scope: Scope, pure: boolean) {
	if (t.isIdentifier(callee)) {
		if (pure) return true;
		const binding = scope.getBinding(callee.name);
		return Boolean(binding?.constant) && !reassignedImport(binding!);
	}
	return pure && repeatable(callee) && !(callee as t.MemberExpression).computed;
}

export interface Hoist {
	anchor: NodePath<t.Statement>;
	/** Operands evaluated before the call, in order, that must run before its body. */
	spills: NodePath<t.Expression>[];
}

/**
 * Operands of a parent that evaluate before a child, when the child is evaluated on
 * every path through the parent. Undefined marks a conditional or unsupported position.
 * Pure says that nothing with effects runs ahead of the parent.
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
		const callee = parent.node.callee;
		const earlier = parent.node.arguments.slice(0, key as number);
		if (fixedCallee(callee, parent.scope, pure)) return earlier;
		// An identifier callee has no receiver, so its value can wait in a temporary.
		return t.isIdentifier(callee) && callee.name !== 'eval' ? [callee, ...earlier] : undefined;
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
	// Earlier properties were counted at the value, one level down.
	if (parent.isObjectExpression() && child.isObjectProperty()) return [];
	// The target of an assignment is evaluated ahead of its right side.
	if (parent.isAssignmentExpression() && key === 'left') return [];
	if (parent.isAssignmentExpression() && key === 'right') {
		const { left, operator } = parent.node;
		// A logical assignment evaluates its right side on some paths only.
		if (logicalAssignmentOperator(operator)) return undefined;
		// A compound assignment reads its target first, so nothing with effects may run
		// ahead of that read.
		if (operator !== '=' && !pure) return undefined;
		if (t.isIdentifier(left)) return [];
		if (t.isMemberExpression(left))
			return left.computed ? [left.object, left.property] : [left.object];
		return undefined;
	}
	if (parent.isTemplateLiteral()) return key === 0 ? [] : undefined;
	if (transparent(parent)) return [];
	return undefined;
}

/** A value that can stay in place while a body runs ahead of it. */
function fixedOperand(node: t.Node, stable: (node: t.Expression) => boolean) {
	if (constantValue(node) || t.isThisExpression(node) || t.isFunction(node)) return true;
	if (t.isUnaryExpression(node, { operator: 'void' })) return fixedOperand(node.argument, stable);
	return t.isExpression(node) && stable(node);
}

/**
 * The operands at one level that must move into temporaries before a body can run
 * ahead of the child. Undefined when the child's position cannot be hoisted out of.
 */
function spillsAt(
	child: NodePath,
	pure: boolean,
	stable: (node: t.Expression) => boolean
): NodePath<t.Expression>[] | undefined {
	const operands = precedingOperands(child, pure);
	if (!operands) return;
	const spills: NodePath<t.Expression>[] = [];
	for (const operand of operands) {
		if (!operand || fixedOperand(operand, stable)) continue;
		if (t.isSpreadElement(operand) || t.isArgumentPlaceholder(operand)) return;
		if (!t.isExpression(operand)) return;
		// Earlier property values belong to sibling properties of an object literal.
		const parent = child.parentPath!;
		const path = findOperand(parent.isObjectProperty() ? parent.parentPath! : parent, operand);
		if (!path) return;
		spills.push(path);
	}
	return spills;
}

export interface Level {
	spills: NodePath<t.Expression>[];
	/** Whether everything that runs ahead of the parent is still free of effects. */
	pure: boolean;
}

/**
 * One step outward from a child. A spilled operand with effects runs ahead of the
 * parent like an impure body would, so the level is then judged as impure.
 */
export function hoistLevel(
	child: NodePath,
	pure: boolean,
	stable: (node: t.Expression) => boolean
): Level | undefined {
	let spills = spillsAt(child, pure, stable);
	if (pure && spills?.some((operand) => !effectFree(operand))) {
		pure = false;
		spills = spillsAt(child, false, stable);
	}
	return spills && { spills, pure };
}

/**
 * The statement an expression's expansion can precede, with the operands that must be
 * evaluated into temporaries first so that nothing is reordered or repeated.
 */
export function hoistAnchor(
	expression: NodePath,
	pure: boolean,
	stable: (node: t.Expression) => boolean
): Hoist | undefined {
	const levels: NodePath<t.Expression>[][] = [];
	let current = expression;
	while (current.parentPath) {
		const level = hoistLevel(current, pure, stable);
		if (!level) return;
		pure = level.pure;
		const parent = current.parentPath;
		levels.push(level.spills);
		if (parent.isStatement())
			return { anchor: parent as NodePath<t.Statement>, spills: levels.reverse().flat() };
		current = parent;
	}
	return;
}

/** Move the operands a hoist must evaluate early into constants, in evaluation order. */
export function spillOperands(hoist: Hoist, snapshots: WeakSet<t.Identifier>) {
	const statements: t.VariableDeclaration[] = [];
	for (const operand of hoist.spills) {
		const id = operand.scope.generateUidIdentifier('operand');
		snapshots.add(id);
		statements.push(t.variableDeclaration('const', [t.variableDeclarator(id, operand.node)]));
		operand.replaceWith(t.cloneNode(id));
	}
	return statements;
}

/**
 * Make the leading declarations among inserted statements known to their scope, so that
 * later expansions can leave reads of them in place instead of copying them again.
 */
export function registerDeclarations(inserted: NodePath[], count: number) {
	for (const path of inserted.slice(0, count))
		if (path.isVariableDeclaration()) path.scope.registerDeclaration(path);
}

/** The path of an operand under a parent. Assignment targets and property values sit a level down. */
function findOperand(parent: NodePath, node: t.Node): NodePath<t.Expression> | undefined {
	let found: NodePath<t.Expression> | undefined;
	for (const key of t.VISITOR_KEYS[parent.node.type]) {
		const value = (parent.node as unknown as Record<string, unknown>)[key];
		if (Array.isArray(value)) {
			const index = value.indexOf(node);
			if (index >= 0) found = parent.get(`${key}.${index}`) as NodePath<t.Expression>;
		} else if (value === node) found = parent.get(key) as NodePath<t.Expression>;
		if (found) return found;
	}
	parent.traverse({
		enter(path) {
			if (path.node !== node) return;
			found = path as NodePath<t.Expression>;
			path.stop();
		},
	});
	return found;
}
