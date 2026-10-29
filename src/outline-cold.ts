import { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { terminates } from './utils/restructure-returns';

function endsInThrow(statement: t.Statement): boolean {
	if (t.isThrowStatement(statement)) return true;
	if (t.isBlockStatement(statement))
		return statement.body.length > 0 && endsInThrow(statement.body[statement.body.length - 1]);
	if (t.isIfStatement(statement))
		return (
			Boolean(statement.alternate) &&
			endsInThrow(statement.consequent) &&
			endsInThrow(statement.alternate!)
		);
	return false;
}

function annotated(node: t.Node) {
	return Boolean(node.leadingComments?.some((comment) => comment.value.includes('@cold')));
}

/** Rough bytecode weight, enough to skip branches too small to be worth a call. */
function weight(node: t.Node) {
	let total = 0;
	t.traverseFast(node, (child) => {
		if (t.isTemplateLiteral(child)) total += 4 + child.expressions.length * 8;
		else if (t.isCallExpression(child) || t.isNewExpression(child))
			total += 6 + child.arguments.length * 2;
		else if (t.isMemberExpression(child) || t.isOptionalMemberExpression(child)) total += 4;
		else if (t.isIdentifier(child)) total += 1;
		else total += 2;
	});
	return total;
}

export function hasColdAnnotation(path: NodePath<t.Function>) {
	let found = false;
	path.traverse({
		IfStatement(statement) {
			if (
				annotated(statement.node) ||
				annotated(statement.node.consequent) ||
				(statement.node.alternate && annotated(statement.node.alternate))
			)
				found = true;
		},
	});
	return found;
}

interface Candidate {
	fn: NodePath<t.Function>;
	branch: NodePath<t.Statement>;
}

/**
 * Move a branch that cannot continue the surrounding function into a module-level
 * function. The branch reads its surroundings through parameters and either returns
 * through the call or throws, so the hot path keeps only the call.
 */
function outlineBranch({ fn, branch }: Candidate, program: NodePath<t.Program>) {
	if (!branch.node) return;
	const statements = branch.isBlockStatement() ? branch.node.body : [branch.node];
	const params = new Map<string, t.Identifier>();
	let safe = true;
	const within = (path: NodePath | null) => {
		for (let current = path; current; current = current.parentPath)
			if (current === branch) return true;
		return false;
	};
	branch.traverse({
		'ThisExpression|Super|MetaProperty|AwaitExpression|YieldExpression'() {
			safe = false;
		},
		VariableDeclaration(path) {
			if (path.node.kind === 'var') safe = false;
		},
		'BreakStatement|ContinueStatement'(path: NodePath) {
			if ((path.node as t.BreakStatement).label) safe = false;
			const target = path.findParent((parent) => parent.isLoop() || parent.isSwitchStatement());
			if (!target || !within(target)) safe = false;
		},
		Identifier(path) {
			const referenced = path.isReferencedIdentifier();
			const bound = path.isBindingIdentifier();
			if (!referenced && !bound) return;
			if (path.node.name === 'arguments') {
				safe = false;
				return;
			}
			const binding = path.scope.getBinding(path.node.name);
			if (!binding || within(binding.path)) return;
			if (binding.scope === program.scope || binding.kind === 'module') return;
			// A write to a surrounding local cannot cross the call boundary.
			if (binding.constantViolations.some((violation) => within(violation))) safe = false;
			params.set(path.node.name, t.identifier(path.node.name));
		},
	});
	if (!safe) return;
	const returning = terminates(branch.node);
	let hasReturn = false;
	branch.traverse({
		Function(path) {
			path.skip();
		},
		ReturnStatement() {
			hasReturn = true;
		},
	});
	if (hasReturn && !returning) return;
	const top = fn.findParent((parent) => parent.parentPath?.isProgram() ?? false);
	if (!top) return;
	const owner =
		(t.isFunctionDeclaration(fn.node) || t.isFunctionExpression(fn.node)
			? fn.node.id?.name
			: undefined) ||
		(fn.parentPath.isVariableDeclarator() && t.isIdentifier(fn.parentPath.node.id)
			? fn.parentPath.node.id.name
			: 'branch');
	const id = program.scope.generateUidIdentifier(`${owner}Cold`);
	const declaration = t.functionDeclaration(
		id,
		[...params.values()],
		t.blockStatement(statements.map((statement) => t.cloneNode(statement, true)))
	);
	const call = t.callExpression(
		t.cloneNode(id),
		[...params.values()].map((param) => t.cloneNode(param))
	);
	branch.replaceWith(
		t.blockStatement([returning ? t.returnStatement(call) : t.expressionStatement(call)])
	);
	return { top, declaration };
}

/** Outline annotated branches, and throwing branches when enabled, out of the given functions. */
export function outlineCold(functions: Iterable<NodePath<t.Function>>, throws: boolean) {
	const candidates: Candidate[] = [];
	let program: NodePath<t.Program> | undefined;
	for (const fn of functions) {
		program ??= fn.scope.getProgramParent().path as NodePath<t.Program>;
		fn.traverse({
			Function(path) {
				path.skip();
			},
			IfStatement(path) {
				const cold = annotated(path.node);
				for (const key of ['consequent', 'alternate'] as const) {
					const branch = path.get(key) as NodePath<t.Statement>;
					if (!branch.node) continue;
					const marked = cold || annotated(branch.node);
					if (marked || (throws && endsInThrow(branch.node) && weight(branch.node) >= 24))
						candidates.push({ fn, branch });
				}
			},
		});
	}
	if (!program) return 0;
	// Inner branches first, so an outer branch carries the call its inner branch became.
	const outlined: { top: NodePath; declaration: t.FunctionDeclaration }[] = [];
	for (const candidate of candidates.reverse()) {
		const result = outlineBranch(candidate, program);
		if (result) outlined.push(result);
	}
	for (const { top, declaration } of outlined) {
		const [inserted] = top.insertAfter(declaration);
		program.scope.registerDeclaration(inserted);
	}
	return outlined.length;
}
