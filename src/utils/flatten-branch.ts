import { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
	effectFree,
	hoistAnchor,
	hoistLevel,
	insertBeforeStatement,
	spillOperands,
	transparent,
} from './call-position';

type Stable = (node: t.Expression) => boolean;
type Branch = NodePath<t.LogicalExpression> | NodePath<t.ConditionalExpression>;
type TestedLoop = NodePath<t.WhileStatement> | NodePath<t.ForStatement>;

/** An operand that only some paths through its parent expression evaluate. */
function inBranch(child: NodePath) {
	const parent = child.parentPath!;
	return (
		(parent.isLogicalExpression() && child.key === 'right') ||
		(parent.isConditionalExpression() && child.key !== 'test')
	);
}

/** A test that runs ahead of every iteration and can open the loop body instead. */
function inLoopTest(child: NodePath) {
	const parent = child.parentPath!;
	return (parent.isWhileStatement() || parent.isForStatement()) && child.key === 'test';
}

/** Keep an anonymous function or class from taking the name of the variable that receives it. */
function unnamed(value: t.Expression) {
	const anonymous =
		t.isArrowFunctionExpression(value) ||
		((t.isFunctionExpression(value) || t.isClassExpression(value)) && !value.id);
	return anonymous ? t.sequenceExpression([t.numericLiteral(0), value]) : value;
}

/** A value whose evaluation has no effect and cannot fail. */
function inert(value: t.Expression) {
	return (
		(t.isLiteral(value) && !t.isTemplateLiteral(value)) ||
		(t.isUnaryExpression(value, { operator: 'void' }) && t.isLiteral(value.argument))
	);
}

/** The test under which a logical expression goes on to evaluate its right operand. */
function continues(operator: t.LogicalExpression['operator'], left: t.Expression) {
	if (operator === '&&') return left;
	if (operator === '||') return t.unaryExpression('!', left);
	return t.binaryExpression('==', left, t.nullLiteral());
}

/** Whether statements can stand in for every branch and loop test between a call and its statement. */
function flattens(call: NodePath, pure: boolean, stable: Stable) {
	let current = call;
	let ahead = pure;
	while (current.parentPath) {
		if (inLoopTest(current)) return true;
		if (inBranch(current)) {
			// A lifted branch moves whole, so its other operands run ahead with the body.
			ahead = pure && effectFree(current.parentPath.node, call.node);
		} else {
			const level = hoistLevel(current, ahead, stable);
			if (!level) return false;
			ahead = level.pure;
		}
		if (current.parentPath.isStatement()) return true;
		current = current.parentPath;
	}
	return false;
}

function conjuncts(test: t.Expression): t.Expression[] {
	return t.isLogicalExpression(test, { operator: '&&' })
		? [...conjuncts(test.left), ...conjuncts(test.right)]
		: [test];
}

/**
 * Test at the head of the body, so the test is a statement position inside the loop.
 * Each operand of an and chain exits on its own, as the short circuit did.
 */
function openLoopTest(loop: TestedLoop) {
	const { test, body } = loop.node;
	const block = t.blockStatement([
		...conjuncts(test!).map((operand) =>
			t.ifStatement(t.unaryExpression('!', operand), t.breakStatement())
		),
		body,
	]);
	loop.replaceWith(
		loop.isForStatement()
			? t.forStatement(loop.node.init, null, loop.node.update, block)
			: t.whileStatement(t.booleanLiteral(true), block)
	);
}

/** Results map each assignment to whether its target already holds another value. */
function assign(
	target: t.Identifier,
	value: t.Expression,
	results: WeakMap<t.Node, boolean>,
	holdsValue: boolean
) {
	const assignment = t.assignmentExpression('=', t.identifier(target.name), unnamed(value));
	results.set(assignment, holdsValue);
	return t.blockStatement([t.expressionStatement(assignment)]);
}

/** Replace a conditional or logical expression with an if statement that produces its value. */
function liftBranch(
	branch: Branch,
	call: NodePath,
	pure: boolean,
	stable: Stable,
	snapshots: WeakSet<t.Identifier>,
	results: WeakMap<t.Node, boolean>
) {
	let host: NodePath = branch;
	while (transparent(host.parentPath!)) host = host.parentPath!;
	const parent = host.parentPath!;
	const scope = branch.scope;

	// A returned value becomes a return on each path.
	if (parent.isReturnStatement()) {
		if (branch.isConditionalExpression()) {
			const { test, consequent, alternate } = branch.node;
			parent.replaceWithMultiple([
				t.ifStatement(test, t.blockStatement([t.returnStatement(consequent)])),
				t.returnStatement(alternate),
			]);
			return true;
		}
		const { operator, left, right } = branch.node;
		const statements: t.Statement[] = [];
		let kept = left;
		if (!stable(left)) {
			const id = scope.generateUidIdentifier('left');
			statements.push(
				t.variableDeclaration('const', [t.variableDeclarator(id, unnamed(left))])
			);
			kept = t.identifier(id.name);
		}
		parent.replaceWithMultiple([
			...statements,
			t.ifStatement(
				continues(operator, t.cloneNode(kept)),
				t.blockStatement([t.returnStatement(right)])
			),
			t.returnStatement(kept),
		]);
		return true;
	}

	// An unused value needs only the branch.
	if (parent.isExpressionStatement()) {
		if (branch.isConditionalExpression()) {
			const { test, consequent, alternate } = branch.node;
			const taken = t.blockStatement([t.expressionStatement(consequent)]);
			const other = t.blockStatement([t.expressionStatement(alternate)]);
			parent.replaceWith(
				inert(consequent)
					? t.ifStatement(t.unaryExpression('!', test), other)
					: t.ifStatement(test, taken, inert(alternate) ? null : other)
			);
			return true;
		}
		const { operator, left, right } = branch.node;
		parent.replaceWith(
			t.ifStatement(continues(operator, left), t.blockStatement([t.expressionStatement(right)]))
		);
		return true;
	}

	// An and that guards a lone consequent nests, which needs no value.
	if (
		parent.isIfStatement() &&
		!parent.node.alternate &&
		branch.isLogicalExpression({ operator: '&&' })
	) {
		const { left, right } = branch.node;
		parent.replaceWith(
			t.ifStatement(left, t.blockStatement([t.ifStatement(right, parent.node.consequent)]))
		);
		return true;
	}

	// The whole branch moves ahead of the statement, so its other operands count as well.
	const hoist = hoistAnchor(branch, pure && effectFree(branch.node, call.node), stable);
	if (!hoist) return false;
	const anchor = hoist.anchor;

	// A variable declared from the value receives it on each path.
	const declaration = anchor.isVariableDeclaration() ? anchor : undefined;
	const declared =
		declaration &&
		parent.isVariableDeclarator() &&
		declaration.node.declarations.length === 1 &&
		(declaration.node.kind === 'const' || declaration.node.kind === 'let') &&
		declaration.inList &&
		t.isIdentifier(parent.node.id)
			? parent.node.id
			: undefined;
	const target = declared ?? scope.generateUidIdentifier('branch');

	let initial: t.Expression | undefined;
	let statement: t.IfStatement;
	if (branch.isConditionalExpression()) {
		const { test, consequent, alternate } = branch.node;
		statement = t.ifStatement(
			test,
			assign(target, consequent, results, false),
			assign(target, alternate, results, false)
		);
	} else {
		const { operator, left, right } = branch.node;
		initial = unnamed(left);
		statement = t.ifStatement(
			continues(operator, t.identifier(target.name)),
			assign(target, right, results, true)
		);
	}
	const variable = t.variableDeclaration('let', [t.variableDeclarator(target, initial)]);
	const spilled = spillOperands(hoist, snapshots);
	if (declared) {
		declaration!.replaceWithMultiple([...spilled, variable, statement]);
		return true;
	}
	branch.replaceWith(t.identifier(target.name));
	const inserted = insertBeforeStatement(anchor, [...spilled, variable, statement]);
	const binding = inserted[spilled.length];
	binding.scope.registerDeclaration(binding);
	return true;
}

/**
 * Rewrite the outermost branch or loop test around a call as statements, so that a
 * later visit finds the call where its body can run in place. Returns false, leaving
 * the code untouched, when no statement form reaches the call.
 */
export function flattenBranch(
	call: NodePath<t.CallExpression>,
	pure: boolean,
	stable: Stable,
	snapshots: WeakSet<t.Identifier>,
	results: WeakMap<t.Node, boolean>
) {
	if (!flattens(call, pure, stable)) return false;
	let outer: Branch | undefined;
	let current: NodePath = call;
	while (!current.parentPath!.isStatement()) {
		if (inBranch(current)) outer = current.parentPath as Branch;
		current = current.parentPath!;
	}
	if (inLoopTest(current)) {
		openLoopTest(current.parentPath as TestedLoop);
		return true;
	}
	return outer ? liftBranch(outer, call, pure, stable, snapshots, results) : false;
}
