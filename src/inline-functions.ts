import _generate from '@babel/generator';
import { ParseResult } from '@babel/parser';
import _traverse, { NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { resolveBinding } from './collect-metadata';
import { dedupVariables } from './dedup-variables';
import { eliminateWrites } from './eliminate-writes';
import { STATS } from './stats';
import { getBabelDefaultExport } from './utils/babel-exports';
import { hasInlineDecorator, removeDecorators } from './utils/decorator-utils';
import { getFunctionName } from './utils/get-function-name';
import {
	localizeVars,
	leadingSingleUse,
	prepareInlineFunction,
	stableArgument,
	undefinedValue,
} from './utils/prepare-inline-function';

const generate = getBabelDefaultExport(_generate);
const traverse = getBabelDefaultExport(_traverse);

/** Expand calls without moving argument evaluation or sharing invocation-local bindings. */
export function inlineFunctions(ast: ParseResult<t.File>) {
	const ancestry = new WeakMap<t.Node, Set<string>>();
	const transformed = new Map<NodePath<t.Function>, boolean>();
	const initializedSnapshots = new WeakSet<t.Identifier>();
	// Scope crawls discard UID reservations for labels in nested blocks. Keep an
	// independent reservation set for the lifetime of this module's transformation.
	const labels = new Set<string>();
	t.traverseFast(ast, (node) => {
		if (t.isLabeledStatement(node)) labels.add(node.label.name);
	});
	function newLabel(scope: Scope, name: string) {
		let label: t.Identifier;
		do {
			label = scope.generateUidIdentifier(name);
		} while (labels.has(label.name));
		labels.add(label.name);
		return label;
	}
	function mark(node: t.Node, parents: Set<string>) {
		t.traverseFast(node, (child) => {
			if (t.isCallExpression(child)) ancestry.set(child, parents);
		});
	}
	traverse(ast, {
		CallExpression: {
			exit(path) {
				if (!t.isIdentifier(path.node.callee)) return;
				const fn = resolveBinding(path.scope.getBinding(path.node.callee.name));
				if (!fn) return;
				if (
					fn.pure &&
					!path.node.leadingComments?.some((comment) => comment.value.includes('@__PURE__'))
				) {
					t.addComment(path.node, 'leading', '@__PURE__');
				}
				if (
					!fn.inline &&
					!hasInlineDecorator(path.node) &&
					!(
						path.parentPath.isExpressionStatement() &&
						hasInlineDecorator(path.parentPath.node)
					)
				)
					return;
				const parents = ancestry.get(path.node) || new Set<string>();
				if (parents.has(fn.key) || parents.size >= 32) return;
				const prepared = prepareInlineFunction(path, fn, (name) =>
					newLabel(path.scope, name)
				);
				if (!prepared) return;
				const { functionPath, imports } = prepared;
				const original = path.node;
				const callee = t.cloneNode(path.node.callee);
				const calleeTarget = t.isFunctionDeclaration(fn.func)
					? undefined
					: path.scope.generateUidIdentifier('callee');
				const next = new Set([...parents, fn.key]);
				const parentFunction = path.getFunctionParent();
				const args = original.arguments as t.Expression[];
				const body = functionPath.node.body;
				const params = functionPath.node.params as t.Identifier[];
				let replacement: t.Expression | undefined;

				// Stable inputs or one leading, single-use input require no invocation frame.
				// Sequences preserve GetValue semantics (receivers, indirect eval, delete, names).
				const isStable = (argument: t.Expression) =>
					stableArgument(argument, path, initializedSnapshots);
				const stableInputs = args.every(isStable);
				if (
					body.body.length === 1 &&
					t.isReturnStatement(body.body[0]) &&
					(stableInputs ||
						(args.length > 0 &&
							params.length > 0 &&
							args.slice(1).every(isStable) &&
							leadingSingleUse(
								body.body[0].argument,
								functionPath.scope.getBinding(params[0].name)!
							))) &&
					params.every((param) => functionPath.scope.getBinding(param.name)?.constant)
				) {
					for (let index = 0; index < params.length; index++) {
						const binding = functionPath.scope.getBinding(params[index].name)!;
						for (const reference of binding.referencePaths) {
							const argument = t.cloneNode(args[index] || undefinedValue(), true);
							reference.replaceWith(
								stableInputs
									? argument
									: t.sequenceExpression([t.numericLiteral(0), argument])
							);
						}
					}
					replacement = t.sequenceExpression([
						t.numericLiteral(0),
						body.body[0].argument || undefinedValue(),
					]);
					if (calleeTarget) {
						// Expression substitution needs no frame, but a variable-backed
						// callee can still be uninitialized. Keep its native failure path.
						replacement = t.conditionalExpression(
							t.binaryExpression(
								'===',
								t.unaryExpression('typeof', t.cloneNode(callee)),
								t.stringLiteral('function')
							),
							replacement,
							t.callExpression(
								t.cloneNode(callee),
								args.map((arg) => t.cloneNode(arg, true))
							)
						);
					}
				}

				// Keep the original import: other references and module initialization still matter.
				if (imports.length) {
					const program = path.scope.getProgramParent().path as NodePath<t.Program>;
					// Register only the injected imports. A full crawl would discard the UID
					// reservations for invocation locals that have not been inserted yet.
					for (const declaration of program.unshiftContainer('body', imports))
						program.scope.registerDeclaration(declaration);
				}
				STATS.incrementInlinedFunctionCount(fn.name);
				if (parentFunction) {
					const pure = (transformed.get(parentFunction) ?? true) && fn.pure;
					transformed.set(parentFunction, pure);
					STATS.setTransformedFunction(getFunctionName(parentFunction), pure);
				}
				removeDecorators(original);
				// Argument effects now live inside the expansion. A PURE annotation on a
				// zero-argument wrapper would incorrectly let bundlers erase those effects.
				original.leadingComments = original.leadingComments?.filter(
					(comment) => !/[@#]__PURE__/.test(comment.value)
				);
				if (replacement) {
					mark(replacement, next);
					path.replaceWith(replacement);
					return;
				}

				const result = path.scope.generateUidIdentifier('result');
				const exit = newLabel(path.scope, 'inline');
				const captured = args.map(() => path.scope.generateUidIdentifier('arg'));
				for (const id of captured) initializedSnapshots.add(id);
				const parameterDeclarations = params.map((param, index) => {
					const id = t.cloneNode(param);
					const constant = functionPath.scope.getBinding(param.name)?.constant;
					if (constant) initializedSnapshots.add(id);
					return t.variableDeclaration(constant ? 'const' : 'let', [
						t.variableDeclarator(
							id,
							captured[index] ? t.cloneNode(captured[index]) : undefinedValue()
						),
					]);
				});
				const locals = localizeVars(functionPath);
				functionPath.traverse({
					Function(path) {
						path.skip();
					},
					ReturnStatement(returnPath) {
						const value = returnPath.node.argument || undefinedValue();
						returnPath.replaceWithMultiple([
							t.expressionStatement(
								t.assignmentExpression(
									'=',
									t.cloneNode(result),
									t.sequenceExpression([t.numericLiteral(0), value])
								)
							),
							t.breakStatement(t.cloneNode(exit)),
						]);
					},
				});
				const frame = t.labeledStatement(
					exit,
					t.blockStatement([
						...(calleeTarget
							? [
									t.variableDeclaration('const', [
										t.variableDeclarator(t.cloneNode(calleeTarget), callee),
									]),
								]
							: []),
						...captured.map((id, index) =>
							t.variableDeclaration('const', [
								t.variableDeclarator(
									id,
									t.sequenceExpression([
										t.numericLiteral(0),
										t.cloneNode(args[index], true),
									])
								),
							])
						),
						// A var-backed function can still be uninitialized at this call site. Retain
						// the native failure after evaluating its arguments, before entering the body.
						...(calleeTarget
							? [
									t.ifStatement(
										t.binaryExpression(
											'!==',
											t.unaryExpression('typeof', t.cloneNode(calleeTarget)),
											t.stringLiteral('function')
										),
										t.expressionStatement(
											t.callExpression(
												t.cloneNode(calleeTarget),
												captured.map((id) => t.cloneNode(id))
											)
										)
									),
								]
							: []),
						...parameterDeclarations,
						...locals,
						...body.body,
					])
				);
				const statements = [
					t.variableDeclaration('let', [t.variableDeclarator(t.cloneNode(result))]),
					frame,
				];
				for (const statement of statements) mark(statement, next);
				const parent = path.parentPath;
				if (parent.isExpressionStatement()) {
					parent.replaceWith(t.blockStatement(statements));
				} else if (parent.isReturnStatement()) {
					path.replaceWith(t.cloneNode(result));
					parent.replaceWithMultiple([...statements, parent.node]);
				} else if (
					parent.isVariableDeclarator() &&
					parent.get('init') === path &&
					parent.parentPath.isVariableDeclaration() &&
					parent.parentPath.node.declarations.length === 1 &&
					parent.parentPath.inList
				) {
					const declaration = parent.parentPath;
					path.replaceWith(t.cloneNode(result));
					declaration.insertBefore(statements);
				} else {
					// Conditional operands, loop headers, multiple declarators and nested arguments
					// must execute at the original expression position, with fresh block bindings.
					const wrapper = t.callExpression(
						t.arrowFunctionExpression(
							[],
							t.blockStatement([...statements, t.returnStatement(t.cloneNode(result))])
						),
						[]
					);
					mark(wrapper, next);
					path.replaceWith(wrapper);
				}
			},
		},
	});
	dedupVariables(transformed.keys());
	eliminateWrites(transformed.keys());
	return generate(ast).code;
}
