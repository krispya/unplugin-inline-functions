import { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import {
	constantValue,
	effectFree,
	hoistAnchor,
	hoistLevel,
	insertBeforeStatement,
	logicalAssignmentOperator,
	registerDeclarations,
	repeatable,
	spillOperands,
	transparent,
	unnamed,
} from './call-position';

type Branch = NodePath<t.LogicalExpression> | NodePath<t.ConditionalExpression>;
type Assignment = NodePath<t.AssignmentExpression>;
type TestedLoop = NodePath<t.WhileStatement> | NodePath<t.ForStatement>;

export interface Flattening {
	stable: (node: t.Expression) => boolean;
	/** Constants that hold an operand evaluated ahead of its statement. */
	snapshots: WeakSet<t.Identifier>;
	/** Variables written only by the statements that produce them, ahead of every read. */
	settled: WeakSet<t.Identifier>;
	/** Each generated assignment, with whether its target already holds another value. */
	results: WeakMap<t.Node, boolean>;
}

/** An assignment with an operator whose target can be read again, so it can be spelled out. */
function spelledOut(path: NodePath, logical: boolean): path is Assignment {
	if (!path.isAssignmentExpression() || path.node.operator === '=') return false;
	return logicalAssignmentOperator(path.node.operator) === logical && repeatable(path.node.left);
}

/** An operand that only some paths through its parent expression evaluate. */
function inBranch(child: NodePath) {
	const parent = child.parentPath!;
	return (
		(parent.isLogicalExpression() && child.key === 'right') ||
		(parent.isConditionalExpression() && child.key !== 'test') ||
		(spelledOut(parent, true) && child.key === 'right')
	);
}

/** Spell a ??= b as a ?? (a = b), and a += b as a = a + b. */
function spellOut(assignment: Assignment) {
	const { left, operator, right } = assignment.node;
	const read = t.cloneNode(left) as t.Expression;
	const plain = operator.slice(0, -1);
	assignment.replaceWith(
		logicalAssignmentOperator(operator)
			? t.logicalExpression(
					plain as t.LogicalExpression['operator'],
					read,
					t.assignmentExpression('=', left, right)
				)
			: t.assignmentExpression(
					'=',
					left,
					t.binaryExpression(plain as t.BinaryExpression['operator'], read, right)
				)
	);
}

/** A test that runs ahead of every iteration and can open the loop body instead. */
function inLoopTest(child: NodePath) {
	const parent = child.parentPath!;
	return (parent.isWhileStatement() || parent.isForStatement()) && child.key === 'test';
}

/** The test under which a logical expression goes on to evaluate its right operand. */
function continues(operator: t.LogicalExpression['operator'], left: t.Expression) {
	if (operator === '&&') return left;
	if (operator === '||') return t.unaryExpression('!', left);
	return t.binaryExpression('==', left, t.nullLiteral());
}

interface Steps {
	/** A compound assignment that must read its target ahead of what moves. */
	compound?: Assignment;
	/** The outermost branch around the call. */
	outer?: Branch | Assignment;
	loop?: TestedLoop;
}

/**
 * The rewrites that leave a call where its body can run in place, or undefined when
 * some position between the call and its statement has no statement form.
 */
function plan(call: NodePath, pure: boolean, stable: Flattening['stable']): Steps | undefined {
	const steps: Steps = {};
	let current = call;
	let ahead = pure;
	while (current.parentPath) {
		const parent = current.parentPath;
		if (inLoopTest(current)) return { ...steps, loop: parent as TestedLoop };
		if (inBranch(current)) {
			steps.outer = parent as Branch | Assignment;
			// A lifted branch moves whole, so its other operands run ahead with the body.
			ahead = pure && effectFree(parent);
		} else {
			const level = hoistLevel(current, ahead, stable);
			if (level) ahead = level.pure;
			else if (current.key === 'right' && spelledOut(parent, false)) steps.compound ??= parent;
			else return;
		}
		if (parent.isStatement()) return steps;
		current = parent;
	}
	return;
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
function liftBranch(branch: Branch, pure: boolean, context: Flattening) {
	const { stable, snapshots, settled, results } = context;
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
				constantValue(consequent)
					? t.ifStatement(t.unaryExpression('!', test), other)
					: t.ifStatement(test, taken, constantValue(alternate) ? null : other)
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
	const hoist = hoistAnchor(branch, pure && effectFree(branch), stable);
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
		const inserted = declaration!.replaceWithMultiple([...spilled, variable, statement]);
		registerDeclarations(inserted, spilled.length);
		return true;
	}
	branch.replaceWith(t.identifier(target.name));
	settled.add(target);
	const inserted = insertBeforeStatement(anchor, [...spilled, variable, statement]);
	registerDeclarations(inserted, spilled.length + 1);
	return true;
}

/**
 * Make one rewrite toward a call whose body needs statements, so that a later visit
 * finds the call where the body can run in place. Returns false, leaving the code
 * untouched, when no statement form reaches the call.
 */
export function flattenBranch(call: NodePath<t.CallExpression>, pure: boolean, context: Flattening) {
	const steps = plan(call, pure, context.stable);
	if (!steps) return false;
	if (steps.compound) spellOut(steps.compound);
	else if (steps.loop) openLoopTest(steps.loop);
	else if (!steps.outer) return false;
	else if (steps.outer.isAssignmentExpression()) spellOut(steps.outer);
	else return liftBranch(steps.outer as Branch, pure, context);
	return true;
}
