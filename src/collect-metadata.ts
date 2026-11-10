import { ParseResult } from '@babel/parser';
import _traverse, { Binding, NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { getBabelDefaultExport } from './utils/babel-exports';
import { hasInlineDecorator, hasPureDecorator } from './utils/decorator-utils';
import { getResolutionConfig } from './utils/resolution-config';
import { ResolvedModulePath, resolveModulePath } from './utils/resolve-module-path';

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
type ResolvedValue = InlinableFunction | { namespace: string } | { unknown: string };
const sourceResolutions = new Map<string, ResolvedModulePath>();
const exportResolutions = new Map<string, ResolvedValue | undefined>();
let resolutionConfig: ReturnType<typeof getResolutionConfig>;

function clearResolutions() {
	sourceResolutions.clear();
	exportResolutions.clear();
}

function currentResolutionConfig() {
	const config = getResolutionConfig();
	if (config !== resolutionConfig) {
		clearResolutions();
		resolutionConfig = config;
	}
	return config;
}

function valueKey(value: ResolvedValue) {
	return 'namespace' in value ? value.namespace : 'unknown' in value ? value.unknown : value.key;
}

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
	clearResolutions();
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

function resolveModule(source: string, importer: string) {
	const config = currentResolutionConfig();
	if (!config) return;
	const key = JSON.stringify([importer, source]);
	const known = sourceResolutions.get(key);
	if (known) return known;
	const resolution = resolveModulePath(source, importer, config);
	sourceResolutions.set(key, resolution);
	return resolution;
}

export function resolveSource(source: string, importer: string): string | undefined {
	const resolution = resolveModule(source, importer);
	return resolution?.isLocal ? resolution.resolved || undefined : undefined;
}

export function sameExternalSource(source: string, original: string, caller: string): boolean {
	const originalTarget = resolveModule(source, original)?.resolved;
	return originalTarget != null && originalTarget === resolveModule(source, caller)?.resolved;
}

function exportedValue(
	filename: string,
	name: string,
	visited: Set<string>
): ResolvedValue | undefined {
	currentResolutionConfig();
	const key = JSON.stringify([filename, name]);
	// Cache complete queries only, since a cycle can truncate an intermediate lookup.
	if (!visited.size) {
		if (exportResolutions.has(key)) return exportResolutions.get(key);
		const result = findExportedValue(filename, name, visited);
		exportResolutions.set(key, result);
		return result;
	}
	return findExportedValue(filename, name, visited);
}

function findExportedValue(
	filename: string,
	name: string,
	visited: Set<string>
): ResolvedValue | undefined {
	const key = JSON.stringify([filename, name]);
	if (visited.has(key)) return;
	visited.add(key);
	const module = modules.get(filename);
	if (!module) return { unknown: key };
	for (const statement of module.node.body) {
		if (t.isExportDefaultDeclaration(statement) && name === 'default') {
			if (t.isIdentifier(statement.declaration))
				return (
					resolveValue(module.scope.getBinding(statement.declaration.name), visited) ?? {
						unknown: key,
					}
				);
			if (t.isFunctionDeclaration(statement.declaration) && statement.declaration.id)
				return resolveValue(module.scope.getBinding(statement.declaration.id.name), visited);
			const location = bindingKey(statement.declaration);
			return (location ? functionsByLocation.get(location) : undefined) ?? { unknown: key };
		}
		if (t.isExportNamedDeclaration(statement)) {
			if (statement.exportKind === 'type') continue;
			if (
				statement.declaration &&
				name in t.getOuterBindingIdentifiers(statement.declaration)
			) {
				return resolveValue(module.scope.getBinding(name), visited) ?? { unknown: key };
			}
			for (const specifier of statement.specifiers) {
				if (t.isExportNamespaceSpecifier(specifier) && specifier.exported.name === name) {
					const source =
						statement.source && resolveSource(statement.source.value, filename);
					return source ? { namespace: source } : { unknown: key };
				}
				if (!t.isExportSpecifier(specifier) || specifier.exportKind === 'type') continue;
				const exported = t.isIdentifier(specifier.exported)
					? specifier.exported.name
					: specifier.exported.value;
				if (exported !== name) continue;
				if (!statement.source)
					return (
						resolveValue(module.scope.getBinding(specifier.local.name), visited) ?? {
							unknown: key,
						}
					);
				const source = resolveSource(statement.source.value, filename);
				return source
					? exportedValue(source, specifier.local.name, visited)
					: { unknown: key };
			}
		}
	}
	// Explicit exports take precedence regardless of their position in the module.
	let starExport: ResolvedValue | undefined;
	for (const statement of module.node.body) {
		if (
			t.isExportAllDeclaration(statement) &&
			statement.exportKind !== 'type' &&
			name !== 'default'
		) {
			const source = resolveSource(statement.source.value, filename);
			const candidate = source
				? exportedValue(source, name, new Set(visited))
				: { unknown: JSON.stringify([filename, statement.source.value, name]) };
			if (candidate) {
				if (starExport && valueKey(starExport) !== valueKey(candidate))
					return { unknown: key };
				starExport = candidate;
			}
		}
	}
	return starExport;
}

function resolveValue(
	binding: Binding | undefined,
	visited = new Set<string>()
): ResolvedValue | undefined {
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
		if (original && original !== binding) return resolveValue(original, visited);
		return;
	}
	const specifier = binding.path;
	if (
		!specifier.isImportSpecifier() &&
		!specifier.isImportDefaultSpecifier() &&
		!specifier.isImportNamespaceSpecifier()
	)
		return;
	const declaration = specifier.parentPath;
	if (!declaration.isImportDeclaration() || declaration.node.importKind === 'type') return;
	if (specifier.isImportSpecifier() && specifier.node.importKind === 'type') return;
	// Injected imports retain source locations but their specifiers belong to the caller.
	const filename =
		binding.scope.getProgramParent().path.node.loc?.filename || declaration.node.loc?.filename;
	const source = filename && resolveSource(declaration.node.source.value, filename);
	if (!source) return;
	if (specifier.isImportNamespaceSpecifier()) return { namespace: source };
	const imported = specifier.isImportDefaultSpecifier()
		? 'default'
		: t.isIdentifier(specifier.node.imported)
			? specifier.node.imported.name
			: specifier.node.imported.value;
	return exportedValue(source, imported, visited);
}

export function resolveBinding(binding: Binding | undefined, visited = new Set<string>()) {
	const value = resolveValue(binding, visited);
	return value && 'func' in value ? value : undefined;
}

/** Resolve static namespace members by binding, never by a variable's spelling. */
export function resolveCall(call: NodePath<t.CallExpression>): InlinableFunction | undefined {
	const members: string[] = [];
	let callee = call.node.callee;
	while (t.isMemberExpression(callee)) {
		if (!callee.computed && t.isIdentifier(callee.property))
			members.unshift(callee.property.name);
		else if (callee.computed && t.isStringLiteral(callee.property))
			members.unshift(callee.property.value);
		else return;
		callee = callee.object;
	}
	if (!t.isIdentifier(callee)) return;
	let value = resolveValue(call.scope.getBinding(callee.name));
	for (const member of members) {
		if (!value || !('namespace' in value)) return;
		value = exportedValue(value.namespace, member, new Set());
	}
	return value && 'func' in value ? value : undefined;
}

function reassignedExport(filename: string, name: string, depth: number): boolean {
	const module = modules.get(filename);
	if (!module || depth > 4) return false;
	const local = (localName: string) => {
		const binding = module.scope.getBinding(localName);
		return Boolean(binding && (!binding.constant || reassignedImport(binding, depth + 1)));
	};
	for (const statement of module.node.body) {
		if (t.isExportDefaultDeclaration(statement) && name === 'default')
			return t.isIdentifier(statement.declaration) && local(statement.declaration.name);
		if (!t.isExportNamedDeclaration(statement) || statement.exportKind === 'type') continue;
		if (statement.declaration && name in t.getOuterBindingIdentifiers(statement.declaration))
			return local(name);
		for (const specifier of statement.specifiers) {
			if (!t.isExportSpecifier(specifier)) continue;
			const exported = t.isIdentifier(specifier.exported)
				? specifier.exported.name
				: specifier.exported.value;
			if (exported !== name) continue;
			if (!statement.source) return local(specifier.local.name);
			const source = resolveSource(statement.source.value, filename);
			return Boolean(source && reassignedExport(source, specifier.local.name, depth + 1));
		}
	}
	return module.node.body.some((statement) => {
		if (!t.isExportAllDeclaration(statement) || name === 'default') return false;
		const source = resolveSource(statement.source.value, filename);
		return Boolean(source && reassignedExport(source, name, depth + 1));
	});
}

/**
 * Whether an imported binding can change value because the module that exports it
 * assigns it again. Modules outside the build are taken to export constants.
 */
export function reassignedImport(binding: Binding, depth = 0): boolean {
	const specifier = binding.path;
	if (!specifier.isImportSpecifier() && !specifier.isImportDefaultSpecifier()) return false;
	const declaration = specifier.parentPath;
	if (!declaration.isImportDeclaration()) return false;
	const filename =
		binding.scope.getProgramParent().path.node.loc?.filename || declaration.node.loc?.filename;
	const source = filename && resolveSource(declaration.node.source.value, filename);
	if (!source) return false;
	const imported = specifier.isImportDefaultSpecifier()
		? 'default'
		: t.isIdentifier(specifier.node.imported)
			? specifier.node.imported.name
			: specifier.node.imported.value;
	return reassignedExport(source, imported, depth);
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

/** The initializer of a constant a module exports under a name, following one re-export. */
export function exportedConstant(
	filename: string,
	name: string,
	depth = 0
): { init: t.Expression; scope: Scope } | undefined {
	const module = modules.get(filename);
	if (!module || depth > 4) return;
	for (const statement of module.get('body')) {
		if (!statement.isExportNamedDeclaration() || statement.node.exportKind === 'type') continue;
		const declaration = statement.get('declaration');
		if (declaration.isVariableDeclaration({ kind: 'const' })) {
			for (const declarator of declaration.get('declarations')) {
				if (t.isIdentifier(declarator.node.id, { name }) && declarator.node.init)
					return { init: declarator.node.init, scope: declarator.scope };
			}
			continue;
		}
		for (const specifier of statement.node.specifiers) {
			if (!t.isExportSpecifier(specifier)) continue;
			const exported = t.isIdentifier(specifier.exported)
				? specifier.exported.name
				: specifier.exported.value;
			if (exported !== name) continue;
			if (statement.node.source) {
				const source = resolveSource(statement.node.source.value, filename);
				return source ? exportedConstant(source, specifier.local.name, depth + 1) : undefined;
			}
			const binding = module.scope.getBinding(specifier.local.name);
			if (
				binding?.kind === 'const' &&
				binding.path.isVariableDeclarator() &&
				binding.path.node.init
			)
				return { init: binding.path.node.init, scope: binding.path.scope };
		}
	}
	return;
}

export function resetMetadata() {
	clearResolutions();
	allFunctions.clear();
	inlinableFunctions.clear();
	pureFunctions.clear();
	functionsByLocation.clear();
	modules.clear();
}
