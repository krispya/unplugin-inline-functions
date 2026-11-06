import { ParseResult } from '@babel/parser';
import _traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getBabelDefaultExport } from './utils/babel-exports';

function annotated(path: NodePath<t.VariableDeclaration>) {
	return path.node.leadingComments?.some((comment) => /(?:^|\s)@scalar\b/.test(comment.value));
}

function unwrap(expression: t.Expression): t.Expression {
	while (
		t.isTSAsExpression(expression) ||
		t.isTSTypeAssertion(expression) ||
		t.isTSNonNullExpression(expression) ||
		t.isTSSatisfiesExpression(expression) ||
		t.isTSInstantiationExpression(expression) ||
		t.isParenthesizedExpression(expression)
	)
		expression = expression.expression;
	return expression;
}

function effectStatement(expression: t.Expression) {
	// Strings evaluated as array elements or sequence operands are not directives.
	return t.expressionStatement(
		t.isStringLiteral(unwrap(expression))
			? t.sequenceExpression([t.numericLiteral(0), expression])
			: expression
	);
}

/** Replace private fixed-size scratch arrays without changing evaluation order. */
export function scalarReplace(ast: ParseResult<t.File>, inlined: Iterable<NodePath<t.Function>>) {
	const automatic = new Set([...inlined].map((path) => path.node));
	const changed = new Set<NodePath<t.Function>>();
	const dynamic = new Map<t.Function, boolean>();
	getBabelDefaultExport(_traverse)(ast, {
		VariableDeclaration(path) {
			const owner = path.getFunctionParent();
			if (
				!owner ||
				path.node.kind !== 'const' ||
				path.node.declarations.length < 2 ||
				!path.parentPath.isBlockStatement() ||
				(!automatic.has(owner.node) && !annotated(path))
			)
				return;
			// Separate declarations retain their order and the block's lexical bindings.
			path.replaceWithMultiple(
				path.node.declarations.map((declaration) => {
					const statement = t.cloneNode(path.node);
					statement.declarations = [declaration];
					return statement;
				})
			);
		},
	});
	getBabelDefaultExport(_traverse)(ast, {
		Program(path) {
			path.scope.crawl();
		},
		VariableDeclaration(path) {
			if (
				path.node.kind !== 'const' ||
				path.node.declarations.length !== 1 ||
				!path.parentPath.isBlockStatement()
			)
				return;
			const owner = path.getFunctionParent();
			if (!owner) return;
			const declaration = path.get('declarations')[0];
			const { id } = declaration.node;
			if (!t.isIdentifier(id) || !declaration.node.init) return;
			let init = unwrap(declaration.node.init);
			const prefix: t.Expression[] = [];
			while (t.isSequenceExpression(init)) {
				prefix.push(...init.expressions.slice(0, -1));
				init = unwrap(init.expressions[init.expressions.length - 1]);
			}
			if (
				!t.isArrayExpression(init) ||
				!init.elements.length ||
				!init.elements.every(t.isExpression)
			)
				return;
			const explicit = annotated(path);
			// Automatic replacement targets small vectors and matrices in expanded callers.
			if (!explicit && (!automatic.has(owner.node) || init.elements.length > 16)) return;
			const binding = declaration.scope.getBinding(id.name);
			if (!binding?.constant) return;
			if (!dynamic.has(owner.node)) {
				let found = false;
				owner.traverse({
					CallExpression(call) {
						if (
							t.isExpression(call.node.callee) &&
							t.isIdentifier(unwrap(call.node.callee), { name: 'eval' })
						)
							found = true;
					},
					WithStatement() {
						found = true;
					},
				});
				dynamic.set(owner.node, found);
			}
			if (dynamic.get(owner.node)) return;
			const accesses: { path: NodePath<t.MemberExpression>; index: number }[] = [];
			for (const reference of binding.referencePaths) {
				// Initialization must precede every access, including assignment targets.
				const statement = reference.findParent(
					(parent) => parent.parentPath === path.parentPath
				);
				if (!statement || (statement.key as number) <= (path.key as number)) return;
				const member = reference.parentPath;
				if (
					reference.getFunctionParent() !== owner ||
					!member?.isMemberExpression() ||
					member.node.object !== reference.node ||
					!member.node.computed ||
					!t.isNumericLiteral(member.node.property)
				)
					return;
				const index = member.node.property.value;
				if (!Number.isInteger(index) || index < 0 || index >= init.elements.length) return;
				let access: NodePath = member;
				while (
					access.parentPath?.isTSAsExpression() ||
					access.parentPath?.isTSTypeAssertion() ||
					access.parentPath?.isTSNonNullExpression() ||
					access.parentPath?.isTSSatisfiesExpression() ||
					access.parentPath?.isTSInstantiationExpression() ||
					access.parentPath?.isParenthesizedExpression()
				)
					access = access.parentPath;
				const parent = access.parentPath!;
				if (
					parent.isUnaryExpression({ operator: 'delete' }) ||
					((parent.isCallExpression() || parent.isOptionalCallExpression()) &&
						parent.node.callee === access.node) ||
					(parent.isTaggedTemplateExpression() && parent.node.tag === access.node)
				)
					return;
				if (parent.isAssignmentExpression() && parent.node.left === access.node) {
					// Identifier assignments can infer names that element assignments do not.
					let callable = false;
					t.traverseFast(parent.node.right, (node) => {
						if (t.isFunction(node) || t.isClass(node)) callable = true;
					});
					if (callable) return;
				} else if (!access.isReferenced()) return;
				accesses.push({ path: member, index });
			}
			const components = new Map<number, t.Identifier>();
			for (const { index } of accesses) {
				if (!components.has(index))
					components.set(index, path.scope.generateUidIdentifier(`${id.name}${index}`));
			}
			for (const access of accesses)
				access.path.replaceWith(t.cloneNode(components.get(access.index)!));
			const statements: t.Statement[] = prefix.map((expression) =>
				effectStatement(t.cloneNode(expression, true))
			);
			// Evaluate every initializer in array order, even when its component is unused.
			for (let index = 0; index < init.elements.length; index++) {
				let element = t.cloneNode(init.elements[index] as t.Expression, true);
				const component = components.get(index);
				if (component) {
					// Array elements do not infer names for anonymous functions or classes.
					if (t.isFunction(unwrap(element)) || t.isClass(unwrap(element)))
						element = t.sequenceExpression([t.numericLiteral(0), element]);
					statements.push(
						t.variableDeclaration('let', [t.variableDeclarator(component, element)])
					);
				} else if (!t.isNumericLiteral(element)) {
					statements.push(effectStatement(element));
				}
			}
			if (statements.length) path.replaceWithMultiple(statements);
			else {
				// Keep following string expressions outside the directive prologue.
				path.replaceWith(t.emptyStatement());
			}
			changed.add(owner);
		},
	});
	return changed;
}
