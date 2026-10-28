import _generate from '@babel/generator';
import { ParseResult } from '@babel/parser';
import _traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { resolveBinding } from './collect-metadata';
import { dedupVariables } from './dedup-variables';
import { STATS } from './stats';
import { getBabelDefaultExport } from './utils/babel-exports';
import { hasInlineDecorator, removeDecorators } from './utils/decorator-utils';
import { getFunctionName } from './utils/get-function-name';
import {
	localizeVars,
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
				const prepared = prepareInlineFunction(path, fn);
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

				// Stable inputs and a single return require no invocation frame. The sequence
				// preserves GetValue semantics (method receivers, indirect eval, delete, names).
				if (
					!calleeTarget &&
					body.body.length === 1 &&
					t.isReturnStatement(body.body[0]) &&
					args.every((argument) => stableArgument(argument, path)) &&
					params.every((param) => functionPath.scope.getBinding(param.name)?.constant)
				) {
					for (let index = 0; index < params.length; index++) {
						const binding = functionPath.scope.getBinding(params[index].name)!;
						for (const reference of binding.referencePaths)
							reference.replaceWith(t.cloneNode(args[index] || undefinedValue(), true));
					}
					replacement = t.sequenceExpression([
						t.numericLiteral(0),
						body.body[0].argument || undefinedValue(),
					]);
				}

				// Keep the original import: other references and module initialization still matter.
				if (imports.length) {
					const program = path.scope.getProgramParent().path as NodePath<t.Program>;
					program.unshiftContainer('body', imports);
					program.scope.crawl();
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
				const exit = path.scope.generateUidIdentifier('inline');
				const captured = args.map(() => path.scope.generateUidIdentifier('arg'));
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
						...params.map((param, index) =>
							t.variableDeclaration('let', [
								t.variableDeclarator(
									t.cloneNode(param),
									captured[index] ? t.cloneNode(captured[index]) : undefinedValue()
								),
							])
						),
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
	return generate(ast).code;
}
