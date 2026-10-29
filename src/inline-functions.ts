import _generate from '@babel/generator';
import { ParseResult } from '@babel/parser';
import _traverse, { NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { InlinableFunction, resolveBinding } from './collect-metadata';
import { dedupVariables } from './dedup-variables';
import { eliminateWrites } from './eliminate-writes';
import { STATS } from './stats';
import { getBabelDefaultExport } from './utils/babel-exports';
import { enclosingStatement, hoistAnchor, insertBeforeStatement } from './utils/call-position';
import { hasInlineDecorator, removeDecorators } from './utils/decorator-utils';
import { getFunctionName } from './utils/get-function-name';
import { planSubstitutions } from './utils/argument-plan';
import { lowerToExpression } from './utils/lower-to-expression';
import { hasColdAnnotation, outlineCold } from './outline-cold';
import { isTerminal, restructureReturns, terminates } from './utils/restructure-returns';
import {
	localizeVars,
	prepareInlineFunction,
	stableArgument,
	undefinedValue,
} from './utils/prepare-inline-function';

const generate = getBabelDefaultExport(_generate);
const traverse = getBabelDefaultExport(_traverse);

function precedes(before: t.SourceLocation, after: t.SourceLocation) {
	return (
		before.filename === after.filename &&
		(before.end.line < after.start.line ||
			(before.end.line === after.start.line && before.end.column <= after.start.column))
	);
}

/** A callee binding that is initialized whenever this call runs, so expansion cannot hide a failure. */
function calleeInitialized(call: NodePath<t.CallExpression>, fn: InlinableFunction) {
	if (t.isFunctionDeclaration(fn.func)) return true;
	const binding = call.scope.getBinding((call.node.callee as t.Identifier).name);
	if (!binding) return false;
	if (binding.kind === 'module' || binding.kind === 'hoisted') return true;
	const declaration = binding.path.node.loc;
	const site = call.node.loc;
	return Boolean(declaration && site && precedes(declaration, site));
}

/** Whether a function and every inline call it expands can lower to one expression. */
function expandsFlat(
	fn: InlinableFunction,
	flatExpansions: Map<string, boolean>,
	visited = new Set<string>()
): boolean {
	const known = flatExpansions.get(fn.key);
	if (known !== undefined) return known;
	if (visited.has(fn.key)) return false;
	visited.add(fn.key);
	let flat = true;
	fn.path.traverse({
		'Loop|TryStatement|SwitchStatement|LabeledStatement|ThrowStatement|BreakStatement|ContinueStatement|DebuggerStatement|WithStatement|Function|Class'(
			path
		) {
			flat = false;
			path.stop();
		},
		CallExpression(path) {
			if (!t.isIdentifier(path.node.callee)) return;
			const nested = resolveBinding(path.scope.getBinding(path.node.callee.name));
			if (nested?.inline && !expandsFlat(nested, flatExpansions, visited)) {
				flat = false;
				path.stop();
			}
		},
	});
	flatExpansions.set(fn.key, flat);
	return flat;
}

/** Detach a value from its reference so receivers and inferred names match a call result. */
function detached(value: t.Expression) {
	return t.isMemberExpression(value) ||
		t.isOptionalMemberExpression(value) ||
		t.isFunctionExpression(value) ||
		t.isArrowFunctionExpression(value) ||
		t.isClassExpression(value)
		? t.sequenceExpression([t.numericLiteral(0), value])
		: value;
}

/** A value whose evaluation can be dropped when the result is unused. */
function trivial(node: t.Expression | null | undefined) {
	return (
		!node ||
		t.isIdentifier(node) ||
		t.isLiteral(node) ||
		t.isUnaryExpression(node, { operator: 'void' })
	);
}

export interface Expansion {
	key: string;
	name: string;
	weight: number;
}

export interface InlineOptions {
	/** Leave a call in place when it would expand the given function with the given callee. */
	skip?(fn: t.Function, calleeKey: string): boolean;
	/** Receives every expansion made, grouped by the function that grew. */
	expansions?: Map<t.Function, Expansion[]>;
	/** Move throwing branches out of transformed functions. */
	outlineThrows?: boolean;
}

/** Expand calls without moving argument evaluation or sharing invocation-local bindings. */
export function inlineFunctions(ast: ParseResult<t.File>, options: InlineOptions = {}) {
	const ancestry = new WeakMap<t.Node, Set<string>>();
	const transformed = new Map<NodePath<t.Function>, boolean>();
	const initializedSnapshots = new WeakSet<t.Identifier>();
	const loweredParameters = new WeakSet<t.Identifier>();
	const flatExpansions = new Map<string, boolean>();
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
	function inlinable(call: NodePath<t.CallExpression>) {
		if (!t.isIdentifier(call.node.callee)) return false;
		if (hasInlineDecorator(call.node)) return true;
		return Boolean(resolveBinding(call.scope.getBinding(call.node.callee.name))?.inline);
	}
	// Expansions need a statement to precede. Give concise arrows that expand a call a block body.
	traverse(ast, {
		ArrowFunctionExpression(path) {
			const body = path.get('body');
			if (body.isBlockStatement()) return;
			let found = body.isCallExpression() && inlinable(body);
			body.traverse({
				CallExpression(call) {
					if (inlinable(call)) found = true;
				},
			});
			if (found)
				body.replaceWith(t.blockStatement([t.returnStatement(body.node as t.Expression)]));
		},
	});
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
				if (!calleeInitialized(path, fn)) return;
				const parentFunction = path.getFunctionParent();
				if (parentFunction && options.skip?.(parentFunction.node, fn.key)) return;
				const prepared = prepareInlineFunction(path, fn, (name) =>
					newLabel(path.scope, name)
				);
				if (!prepared) return;
				const { functionPath, imports } = prepared;
				const original = path.node;
				const next = new Set([...parents, fn.key]);
				const args = original.arguments as t.Expression[];
				const body = functionPath.node.body;
				const params = functionPath.node.params as t.Identifier[];

				// Parameters read their argument in place when evaluation order allows it.
				// Sequences preserve GetValue semantics (receivers, indirect eval, delete, names).
				const bindings = params.map((param) => functionPath.scope.getBinding(param.name)!);
				const stable = args.map((argument) =>
					stableArgument(argument, path, initializedSnapshots, loweredParameters)
				);
				for (let index = args.length; index < params.length; index++) stable.push(true);
				const surplus = args.slice(params.length).some((argument) => !trivial(argument));
				const plan = planSubstitutions(body.body, params, bindings, stable, surplus);
				for (const index of plan) {
					const argument = args[index];
					for (const reference of bindings[index].referencePaths) {
						if (!argument) reference.replaceWith(undefinedValue());
						else if (stable[index]) reference.replaceWith(t.cloneNode(argument, true));
						else
							reference.replaceWith(
								t.sequenceExpression([
									t.numericLiteral(0),
									t.cloneNode(argument, true),
								])
							);
					}
				}
				let replacement: t.Expression | undefined;
				if (
					body.body.length === 1 &&
					t.isReturnStatement(body.body[0]) &&
					plan.size === params.length &&
					!surplus
				) {
					replacement = detached(body.body[0].argument || undefinedValue());
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
				if (parentFunction && options.expansions) {
					let weight = 0;
					t.traverseFast(body, () => {
						weight++;
					});
					const list = options.expansions.get(parentFunction.node) ?? [];
					list.push({ key: fn.key, name: fn.name, weight });
					options.expansions.set(parentFunction.node, list);
				}
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

				// Remaining parameters snapshot their arguments in order, then surplus arguments run.
				const parameterIds = new Set<t.Identifier>();
				const prologue: t.Statement[] = [];
				params.forEach((param, index) => {
					if (plan.has(index)) return;
					const id = t.cloneNode(param);
					const argument = args[index];
					if (bindings[index].constant) {
						initializedSnapshots.add(id);
						parameterIds.add(id);
					}
					prologue.push(
						t.variableDeclaration(bindings[index].constant ? 'const' : 'let', [
							t.variableDeclarator(
								id,
								argument
									? t.sequenceExpression([
											t.numericLiteral(0),
											t.cloneNode(argument, true),
										])
									: undefinedValue()
							),
						])
					);
				});
				for (const argument of args.slice(params.length))
					if (!trivial(argument))
						prologue.push(t.expressionStatement(t.cloneNode(argument, true)));
				prologue.push(...localizeVars(functionPath));
				const parent = path.parentPath;

				// At a return site the callee's returns are the caller's returns.
				if (parent.isReturnStatement()) {
					const block = t.blockStatement([...prologue, ...body.body]);
					const last =
						parent.inList &&
						parent.key === (parent.container as t.Node[]).length - 1 &&
						parent.parentPath.parentPath?.isFunction();
					if (!terminates(block) && !last) block.body.push(t.returnStatement());
					mark(block, next);
					parent.replaceWith(block);
					return;
				}

				// Early returns become branches so that exits need no jump.
				restructureReturns(body.body);
				const bodyPath = functionPath.get('body');
				const returns: NodePath<t.ReturnStatement>[] = [];
				functionPath.traverse({
					Function(path) {
						path.skip();
					},
					ReturnStatement(returnPath) {
						returns.push(returnPath);
					},
				});
				const terminal = returns.every((returnPath) => isTerminal(returnPath, bodyPath));
				const tail = body.body[body.body.length - 1];
				const singleExit =
					returns.length === 0 || (returns.length === 1 && returns[0].node === tail);

				// Build a block whose returns store into result, or only exit when unused.
				function frame(result?: t.Identifier) {
					const exit = terminal ? undefined : newLabel(path.scope, 'inline');
					for (const returnPath of returns) {
						const value = returnPath.node.argument;
						const statements: t.Statement[] = [];
						if (result)
							statements.push(
								t.expressionStatement(
									t.assignmentExpression(
										'=',
										t.cloneNode(result),
										detached(value || undefinedValue())
									)
								)
							);
						else if (!trivial(value)) statements.push(t.expressionStatement(value!));
						if (exit && !isTerminal(returnPath, bodyPath))
							statements.push(t.breakStatement(t.cloneNode(exit)));
						if (statements.length) returnPath.replaceWithMultiple(statements);
						else returnPath.remove();
					}
					const block = t.blockStatement([...prologue, ...body.body]);
					const statements: t.Statement[] = [
						exit ? t.labeledStatement(exit, block) : block,
					];
					for (const statement of statements) mark(statement, next);
					return statements;
				}

				if (parent.isExpressionStatement()) {
					parent.replaceWith(frame()[0]);
					return;
				}

				// When the call is unconditional, earlier operands move into temporaries and
				// the body runs just ahead of the statement.
				const hoist = hoistAnchor(path, fn.pure, (node) =>
					stableArgument(node, path, initializedSnapshots, loweredParameters)
				);
				const anchor = hoist?.anchor;
				const spill = () => {
					const statements: t.Statement[] = [];
					for (const operand of hoist!.spills) {
						const id = path.scope.generateUidIdentifier('operand');
						initializedSnapshots.add(id);
						statements.push(
							t.variableDeclaration('const', [t.variableDeclarator(id, operand.node)])
						);
						operand.replaceWith(t.cloneNode(id));
					}
					return statements;
				};
				if (anchor && singleExit) {
					const value = returns.length ? returns[0].node.argument : undefined;
					if (returns.length) returns[0].remove();
					const statements = [...prologue, ...body.body];
					for (const statement of statements) mark(statement, next);
					const expression = detached(value || undefinedValue());
					mark(expression, next);
					path.replaceWith(expression);
					const spilled = spill();
					if (statements.length || spilled.length)
						insertBeforeStatement(anchor, [...spilled, ...statements]);
					return;
				}
				if (anchor) {
					// A declared variable receives the result directly.
					const declarator = parent.isVariableDeclarator() ? parent : undefined;
					const declaration = declarator?.parentPath as
						NodePath<t.VariableDeclaration> | undefined;
					if (
						declarator &&
						declaration &&
						t.isIdentifier(declarator.node.id) &&
						declaration.node.declarations.length === 1 &&
						declaration.node.kind !== 'var' &&
						declaration.inList &&
						anchor === declaration
					) {
						const id = declarator.node.id;
						const statements = frame(id);
						declaration.replaceWithMultiple([
							...spill(),
							t.variableDeclaration('let', [t.variableDeclarator(t.cloneNode(id))]),
							...statements,
						]);
						return;
					}
					const result = path.scope.generateUidIdentifier('result');
					const statements = frame(result);
					path.replaceWith(t.cloneNode(result));
					insertBeforeStatement(anchor, [
						...spill(),
						t.variableDeclaration('let', [t.variableDeclarator(t.cloneNode(result))]),
						...statements,
					]);
					return;
				}

				// Straight-line bodies become one expression in place, with hoisted block bindings.
				let closures = false;
				t.traverseFast(body, (node) => {
					if (t.isFunction(node) || t.isClass(node)) closures = true;
				});
				const statement =
					closures || !expandsFlat(fn, flatExpansions)
						? undefined
						: enclosingStatement(path);
				const lowered = statement && lowerToExpression([...prologue, ...body.body]);
				if (statement && lowered) {
					if (lowered.declared.length) {
						const declaration = t.variableDeclaration(
							'let',
							lowered.declared.map((id) => {
								const clone = t.cloneNode(id);
								if (parameterIds.has(id)) loweredParameters.add(clone);
								return t.variableDeclarator(clone);
							})
						);
						const [inserted] = insertBeforeStatement(statement, [declaration]);
						inserted.scope.registerDeclaration(inserted);
					}
					mark(lowered.expression, next);
					path.replaceWith(lowered.expression);
					return;
				}

				// Conditional positions keep the expansion at the original expression position.
				const result = path.scope.generateUidIdentifier('result');
				const statements = frame(result);
				const wrapper = t.callExpression(
					t.arrowFunctionExpression(
						[],
						t.blockStatement([
							t.variableDeclaration('let', [t.variableDeclarator(t.cloneNode(result))]),
							...statements,
							t.returnStatement(t.cloneNode(result)),
						])
					),
					[]
				);
				mark(wrapper, next);
				path.replaceWith(wrapper);
			},
		},
	});
	dedupVariables(transformed.keys());
	eliminateWrites(transformed.keys());
	const cold = new Set<NodePath<t.Function>>(transformed.keys());
	traverse(ast, {
		Function(path) {
			if (hasColdAnnotation(path)) cold.add(path);
		},
	});
	outlineCold(cold, options.outlineThrows ?? true);
	return generate(ast).code;
}
