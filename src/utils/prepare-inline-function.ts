import _traverse, { Binding, NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import {
	bindingKey,
	exportedBindingName,
	InlinableFunction,
	resolveBinding,
	resolveSource,
	sameExternalSource,
} from '../collect-metadata';
import { getBabelDefaultExport } from './babel-exports';
import { createRelativePath } from './create-relative-path';
import { getFunctionBody } from './get-function-body';

const traverse = getBabelDefaultExport(_traverse);

export function undefinedValue() {
	return t.unaryExpression('void', t.numericLiteral(0));
}

function containsScope(scope: Scope, parent: Scope): boolean {
	for (let current: Scope | null = scope; current; current = current.parent) {
		if (current === parent) return true;
	}
	return false;
}

function sameBinding(left: Binding | undefined, right: Binding): boolean {
	return Boolean(left && bindingKey(left.identifier) === bindingKey(right.identifier));
}

function runtimeIdentifier(path: NodePath<t.Identifier>): boolean {
	const referenced = path.isReferencedIdentifier();
	const binding = path.isBindingIdentifier();
	return referenced || binding;
}

/** Plan imports before editing the caller. Inaccessible closures keep their original call. */
function dependencyPlan(call: NodePath<t.CallExpression>, fn: InlinableFunction) {
	const free = new Map<string, Binding | undefined>();
	let safe = !fn.func.async && !fn.func.generator && fn.func.params.every(t.isIdentifier);
	if (
		t.isFunctionExpression(fn.func) &&
		fn.func.id &&
		fn.path.scope.getBinding(fn.func.id.name)?.referenced
	)
		safe = false;
	const params = new Set(fn.func.params.filter(t.isIdentifier).map((param) => param.name));
	fn.path.traverse({
		ThisExpression() {
			safe = false;
		},
		Super() {
			safe = false;
		},
		MetaProperty() {
			safe = false;
		},
		Class() {
			safe = false;
		},
		'TSEnumDeclaration|TSModuleDeclaration|TSImportEqualsDeclaration'() {
			safe = false;
		},
		CatchClause(path) {
			// A var declaration sharing a catch parameter's name has special assignment
			// semantics that cannot be lowered to an ordinary block binding.
			if (
				t.isIdentifier(path.node.param) &&
				fn.path.scope.getBinding(path.node.param.name)?.kind === 'var'
			)
				safe = false;
		},
		VariableDeclarator(path) {
			if (
				!t.isIdentifier(path.node.id) ||
				(!t.isFunctionExpression(path.node.init) &&
					!t.isArrowFunctionExpression(path.node.init))
			)
				return;
			const binding = path.scope.getBinding(path.node.id.name);
			if (
				binding?.referencePaths.some(
					(reference) =>
						!reference.parentPath?.isCallExpression() || reference.key !== 'callee'
				)
			)
				safe = false;
		},
		CallExpression(path) {
			if (t.isIdentifier(path.node.callee, { name: 'eval' })) safe = false;
		},
		Identifier(path) {
			if (path.parentPath === fn.path && path.key === 'id') return;
			if (
				path.findParent(
					(parent) =>
						parent.isTSType() ||
						parent.isTSTypeAnnotation() ||
						parent.isTSTypeAliasDeclaration() ||
						parent.isTSInterfaceDeclaration()
				)
			)
				return;
			if (!runtimeIdentifier(path)) return;
			if (path.node.name === 'arguments') {
				safe = false;
				return;
			}
			const binding = path.scope.getBinding(path.node.name);
			if (binding && containsScope(binding.scope, fn.path.scope)) return;
			if (binding && resolveBinding(binding)?.key === fn.key) safe = false;
			free.set(path.node.name, binding);
		},
		FunctionDeclaration(path) {
			if (
				path.parentPath === fn.path.get('body') &&
				path.node.id &&
				params.has(path.node.id.name)
			)
				safe = false;
			const binding = path.node.id && path.parentPath.scope.getBinding(path.node.id.name);
			if (
				binding &&
				binding.referencePaths.some(
					(reference) =>
						!reference.parentPath?.isCallExpression() || reference.key !== 'callee'
				)
			)
				safe = false;
		},
	});
	if (!safe) return;

	const callerFile = call.scope.getProgramParent().path.node.loc?.filename;
	const names = new Map<string, string>();
	const imports: t.ImportDeclaration[] = [];
	for (const [name, binding] of free) {
		const callerBinding = call.scope.getBinding(name);
		if (!binding) {
			// A free global must not become a caller's local variable.
			if (callerBinding) return;
			continue;
		}
		if (sameBinding(callerBinding, binding)) continue;
		if (!callerFile || !binding.scope.path.isProgram()) return;
		// Imported bindings cannot represent writes to a callee module's local variable.
		if (binding.constantViolations.some((path) => containsScope(path.scope, fn.path.scope)))
			return;
		const local = call.scope.generateUidIdentifier(name);
		let specifier: t.ImportSpecifier | t.ImportDefaultSpecifier | t.ImportNamespaceSpecifier;
		let source: string;
		let template: t.ImportDeclaration | undefined;
		if (
			binding.path.isImportSpecifier() ||
			binding.path.isImportDefaultSpecifier() ||
			binding.path.isImportNamespaceSpecifier()
		) {
			const declaration = binding.path.parentPath;
			if (!declaration.isImportDeclaration()) return;
			specifier = t.cloneNode(binding.path.node, true);
			specifier.local = local;
			const importer = declaration.node.loc?.filename;
			const resolved = importer && resolveSource(declaration.node.source.value, importer);
			if (!resolved && declaration.node.source.value.startsWith('.')) return;
			// Identical package specifiers can resolve to different installed versions.
			if (
				!resolved &&
				(!importer ||
					!sameExternalSource(declaration.node.source.value, importer, callerFile))
			)
				return;
			source = resolved
				? createRelativePath(callerFile, resolved)
				: declaration.node.source.value;
			template = declaration.node;
		} else {
			const exported = exportedBindingName(binding);
			const filename = binding.path.node.loc?.filename;
			if (!exported || !filename) return;
			specifier =
				exported === 'default'
					? t.importDefaultSpecifier(local)
					: t.importSpecifier(
							local,
							t.isValidIdentifier(exported)
								? t.identifier(exported)
								: t.stringLiteral(exported)
						);
			source = createRelativePath(callerFile, filename);
		}
		const declaration = template
			? t.cloneNode(template, true)
			: t.importDeclaration([], t.stringLiteral(source));
		declaration.specifiers = [specifier];
		declaration.source = t.stringLiteral(source);
		imports.push(declaration);
		names.set(name, local.name);
	}
	return { names, imports };
}

/** Clone a complete function scope so Babel can rename bindings, including destructured locals. */
export function prepareInlineFunction(call: NodePath<t.CallExpression>, fn: InlinableFunction) {
	if (call.node.arguments.some((argument) => !t.isExpression(argument))) return;
	// These expressions belong to the caller's async/generator context, which a wrapper cannot move.
	let suspended = false;
	for (const argument of call.get('arguments')) {
		if (argument.isAwaitExpression() || argument.isYieldExpression()) suspended = true;
		argument.traverse({
			Function(path) {
				path.skip();
			},
			AwaitExpression() {
				suspended = true;
			},
			YieldExpression() {
				suspended = true;
			},
		});
	}
	if (suspended) return;
	const dependencies = dependencyPlan(call, fn);
	if (!dependencies) return;
	const expression = t.functionExpression(
		null,
		fn.func.params.map((param) => t.cloneNode(param, true)),
		t.cloneNode(getFunctionBody(fn.func), true)
	);
	const ast = t.file(t.program([t.expressionStatement(expression)]));
	let functionPath!: NodePath<t.FunctionExpression>;
	traverse(ast, {
		FunctionExpression(path) {
			if (path.node === expression) {
				functionPath = path;
				path.stop();
			}
		},
	});

	const scopes = new Set<Scope>([functionPath.scope]);
	functionPath.traverse({
		Scopable(path) {
			scopes.add(path.scope);
		},
	});
	for (const scope of scopes) {
		for (const name of Object.keys(scope.bindings))
			scope.rename(name, call.scope.generateUidIdentifier(name).name);
	}
	functionPath.traverse({
		'TSTypeAnnotation|TSTypeParameterInstantiation|TSTypeParameterDeclaration|TSTypeAliasDeclaration|TSInterfaceDeclaration|TSDeclareFunction'(
			path
		) {
			path.remove();
		},
		'TSAsExpression|TSTypeAssertion|TSNonNullExpression|TSSatisfiesExpression|TSInstantiationExpression'(
			path
		) {
			path.replaceWith((path.node as t.TSAsExpression).expression);
		},
		Identifier(path) {
			path.node.optional = false;
			if (!runtimeIdentifier(path) || path.scope.getBinding(path.node.name)) return;
			const replacement = dependencies.names.get(path.node.name);
			if (replacement) path.replaceWith(t.identifier(replacement));
		},
		LabeledStatement(path) {
			const oldName = path.node.label.name;
			const label = call.scope.generateUidIdentifier(oldName);
			path.node.label = label;
			path.get('body').traverse({
				Function(path) {
					path.skip();
				},
				'BreakStatement|ContinueStatement'(path) {
					const node = path.node as t.BreakStatement | t.ContinueStatement;
					if (node.label?.name === oldName) node.label = t.cloneNode(label);
				},
			});
		},
	});
	return { functionPath, imports: dependencies.imports };
}

/** A value-stable argument can be substituted without repeating effects or changing a snapshot. */
export function stableArgument(node: t.Expression, call: NodePath<t.CallExpression>): boolean {
	if (
		t.isNumericLiteral(node) ||
		t.isStringLiteral(node) ||
		t.isBooleanLiteral(node) ||
		t.isNullLiteral(node) ||
		t.isBigIntLiteral(node)
	)
		return true;
	if (!t.isIdentifier(node)) return false;
	const binding = call.scope.getBinding(node.name);
	const owner = call.getFunctionParent();
	if (!binding?.constant || !owner || binding.scope.getFunctionParent() !== owner.scope)
		return false;
	// A call inside a parameter initializer can precede initialization of later parameters.
	if (!call.findParent((path) => path === owner.get('body'))) return false;
	if (binding.kind === 'param') return true;
	return (
		binding.kind === 'const' &&
		Boolean(
			binding.path.node.loc &&
			call.node.loc &&
			(binding.path.node.loc.end.line < call.node.loc.start.line ||
				(binding.path.node.loc.end.line === call.node.loc.start.line &&
					binding.path.node.loc.end.column < call.node.loc.start.column))
		)
	);
}

/** Turn function-scoped vars into per-invocation block bindings, retaining var hoisting. */
export function localizeVars(functionPath: NodePath<t.FunctionExpression>): t.Statement[] {
	const params = new Set(
		functionPath.node.params.filter(t.isIdentifier).map((param) => param.name)
	);
	const names = Object.values(functionPath.scope.bindings)
		.filter((binding) => binding.kind === 'var' && !params.has(binding.identifier.name))
		.map((binding) => t.cloneNode(binding.identifier));
	functionPath.traverse({
		Function(path) {
			path.skip();
		},
		VariableDeclaration(path) {
			if (path.node.kind !== 'var') return;
			const expressions = path.node.declarations
				.filter((declaration) => declaration.init)
				.map((declaration) =>
					t.assignmentExpression('=', declaration.id as t.LVal, declaration.init!)
				);
			if (path.parentPath.isForInStatement() || path.parentPath.isForOfStatement()) {
				path.replaceWith(path.node.declarations[0].id);
			} else if (path.parentPath.isForStatement()) {
				if (!expressions.length) path.remove();
				else
					path.replaceWith(
						expressions.length === 1 ? expressions[0] : t.sequenceExpression(expressions)
					);
			} else if (!expressions.length) path.remove();
			else
				path.replaceWithMultiple(
					expressions.map((expression) => t.expressionStatement(expression))
				);
		},
	});
	return names.length
		? [
				t.variableDeclaration(
					'let',
					names.map((name) => t.variableDeclarator(name))
				),
			]
		: [];
}
