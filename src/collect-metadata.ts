import { ParseResult } from '@babel/parser';
import _traverse, { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { getBabelDefaultExport } from './utils/babel-exports';
import { hasInlineDecorator, hasPureDecorator } from './utils/decorator-utils';
import { getResolutionConfig } from './utils/resolution-config';
import { resolveModulePath } from './utils/resolve-module-path';

const traverse = getBabelDefaultExport(_traverse);
type InlineFunction = t.FunctionDeclaration | t.FunctionExpression | t.ArrowFunctionExpression;

export type InlinableFunction = {
	key: string;
	name: string;
	func: InlineFunction;
	path: NodePath<InlineFunction>;
	inline: boolean;
	pure: boolean;
};

// These name indexes are used for debug summaries only. Transformations resolve bindings.
export const allFunctions = new Map<string, InlinableFunction>();
export const inlinableFunctions = new Map<string, InlinableFunction>();
export const pureFunctions = new Set<string>();
const functionsByLocation = new Map<string, InlinableFunction>();
const modules = new Map<string, NodePath<t.Program>>();

export function bindingKey(node: t.Node): string | undefined {
	const loc = node.loc;
	return loc ? `${loc.filename}:${loc.start.line}:${loc.start.column}:${node.type}` : undefined;
}

function functionNode(binding: Binding): InlineFunction | undefined {
	const node = binding.path.node;
	if (t.isFunctionDeclaration(node)) return node;
	if (
		t.isVariableDeclarator(node) &&
		(t.isFunctionExpression(node.init) || t.isArrowFunctionExpression(node.init))
	) {
		return node.init;
	}
}

export function collectMetadata(ast: ParseResult<t.File>) {
	// Keep definitions immutable: transforming one module must not change another call's template.
	const snapshot = t.cloneNode(ast, true);
	traverse(snapshot, {
		Program(path) {
			const filename = path.node.loc?.filename;
			if (filename) modules.set(filename, path);
		},
		Function(path) {
			if (
				!path.isFunctionDeclaration() &&
				!path.isFunctionExpression() &&
				!path.isArrowFunctionExpression()
			)
				return;
			const key = bindingKey(path.node);
			if (!key) return;
			const parent = path.parentPath;
			const name =
				('id' in path.node && path.node.id?.name) ||
				(parent.isVariableDeclarator() &&
					t.isIdentifier(parent.node.id) &&
					parent.node.id.name) ||
				'default';
			const commentNodes = [path.node, parent.node];
			if (parent.isVariableDeclarator()) {
				commentNodes.push(parent.parentPath.node);
				if (parent.parentPath.parentPath?.isExportNamedDeclaration())
					commentNodes.push(parent.parentPath.parentPath.node);
			}
			const record: InlinableFunction = {
				key,
				name,
				func: path.node,
				path,
				inline: commentNodes.some(hasInlineDecorator),
				pure: commentNodes.some(hasPureDecorator),
			};
			functionsByLocation.set(key, record);
			allFunctions.set(name, record);
			if (record.inline) inlinableFunctions.set(name, record);
			if (record.pure) pureFunctions.add(name);
		},
	});
}

export function resolveSource(source: string, importer: string): string | undefined {
	const config = getResolutionConfig();
	if (!config) return;
	const resolution = resolveModulePath(source, importer, config);
	return resolution.isLocal ? resolution.resolved || undefined : undefined;
}

export function sameExternalSource(source: string, original: string, caller: string): boolean {
	const config = getResolutionConfig();
	if (!config) return false;
	const originalTarget = resolveModulePath(source, original, config).resolved;
	return (
		originalTarget !== null &&
		originalTarget === resolveModulePath(source, caller, config).resolved
	);
}

function exportedFunction(
	filename: string,
	name: string,
	visited: Set<string>
): InlinableFunction | undefined {
	const key = `${filename}:${name}`;
	if (visited.has(key)) return;
	visited.add(key);
	const module = modules.get(filename);
	if (!module) return;
	let starExport: InlinableFunction | undefined;
	for (const statement of module.node.body) {
		if (t.isExportDefaultDeclaration(statement) && name === 'default') {
			if (t.isIdentifier(statement.declaration))
				return resolveBinding(module.scope.getBinding(statement.declaration.name), visited);
			if (t.isFunctionDeclaration(statement.declaration) && statement.declaration.id)
				return resolveBinding(
					module.scope.getBinding(statement.declaration.id.name),
					visited
				);
			const location = bindingKey(statement.declaration);
			return location ? functionsByLocation.get(location) : undefined;
		}
		if (t.isExportNamedDeclaration(statement)) {
			if (statement.exportKind === 'type') continue;
			if (
				statement.declaration &&
				name in t.getOuterBindingIdentifiers(statement.declaration)
			) {
				return resolveBinding(module.scope.getBinding(name), visited);
			}
			for (const specifier of statement.specifiers) {
				if (!t.isExportSpecifier(specifier) || specifier.exportKind === 'type') continue;
				const exported = t.isIdentifier(specifier.exported)
					? specifier.exported.name
					: specifier.exported.value;
				if (exported !== name) continue;
				if (!statement.source)
					return resolveBinding(module.scope.getBinding(specifier.local.name), visited);
				const source = resolveSource(statement.source.value, filename);
				return source ? exportedFunction(source, specifier.local.name, visited) : undefined;
			}
		}
		if (
			t.isExportAllDeclaration(statement) &&
			statement.exportKind !== 'type' &&
			name !== 'default'
		) {
			const source = resolveSource(statement.source.value, filename);
			const candidate = source && exportedFunction(source, name, new Set(visited));
			if (candidate) {
				if (starExport && starExport.key !== candidate.key) return;
				starExport = candidate;
			}
		}
	}
	return starExport;
}

export function resolveBinding(
	binding: Binding | undefined,
	visited = new Set<string>()
): InlinableFunction | undefined {
	if (!binding || !binding.constant) return;
	const node = functionNode(binding);
	if (node) {
		const key = bindingKey(node);
		const record = key ? functionsByLocation.get(key) : undefined;
		if (record) return record;
		// Earlier bundler transforms can change source positions of module declarations.
		const filename = binding.scope.getProgramParent().path.node.loc?.filename;
		const original =
			filename &&
			binding.scope.path.isProgram() &&
			modules.get(filename)?.scope.getBinding(binding.identifier.name);
		if (original && original !== binding) return resolveBinding(original, visited);
		return;
	}
	const specifier = binding.path;
	if (!specifier.isImportSpecifier() && !specifier.isImportDefaultSpecifier()) return;
	const declaration = specifier.parentPath;
	if (!declaration.isImportDeclaration() || declaration.node.importKind === 'type') return;
	if (specifier.isImportSpecifier() && specifier.node.importKind === 'type') return;
	const filename =
		declaration.node.loc?.filename || binding.scope.getProgramParent().path.node.loc?.filename;
	const source = filename && resolveSource(declaration.node.source.value, filename);
	if (!source) return;
	const imported = specifier.isImportDefaultSpecifier()
		? 'default'
		: t.isIdentifier(specifier.node.imported)
			? specifier.node.imported.name
			: specifier.node.imported.value;
	return exportedFunction(source, imported, visited);
}

export function exportedBindingName(binding: Binding): string | undefined {
	const filename = binding.path.node.loc?.filename;
	const module = filename && modules.get(filename);
	if (!module) return;
	for (const statement of module.node.body) {
		if (t.isExportNamedDeclaration(statement) && statement.exportKind !== 'type') {
			if (
				statement.declaration &&
				binding.identifier.name in t.getOuterBindingIdentifiers(statement.declaration)
			)
				return binding.identifier.name;
			if (!statement.source) {
				for (const specifier of statement.specifiers) {
					if (
						t.isExportSpecifier(specifier) &&
						specifier.local.name === binding.identifier.name &&
						specifier.exportKind !== 'type'
					) {
						return t.isIdentifier(specifier.exported)
							? specifier.exported.name
							: specifier.exported.value;
					}
				}
			}
		}
		if (
			t.isExportDefaultDeclaration(statement) &&
			((t.isIdentifier(statement.declaration) &&
				statement.declaration.name === binding.identifier.name) ||
				(t.isFunctionDeclaration(statement.declaration) &&
					statement.declaration.id?.name === binding.identifier.name))
		)
			return 'default';
	}
}

export function resetMetadata() {
	allFunctions.clear();
	inlinableFunctions.clear();
	pureFunctions.clear();
	functionsByLocation.clear();
	modules.clear();
}
