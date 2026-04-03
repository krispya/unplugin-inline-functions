import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { resolveExportPath } from './resolve-export-path';

export type FollowPackageImportsOption = boolean | 'workspace' | 'all';

export type ModuleImportKind = 'relative' | 'absolute' | 'alias' | 'package' | 'custom';

export interface ResolveImportContext {
	projectRoot: string;
	workspaceRoot: string;
}

export type ResolveImportHook = (
	specifier: string,
	importer: string,
	context: ResolveImportContext
) => string | null | undefined;

export interface ResolveModulePathOptions extends ResolveImportContext {
	alias?: Record<string, string>;
	followPackageImports?: FollowPackageImportsOption;
	resolveImport?: ResolveImportHook;
}

export interface ResolvedModulePath {
	kind: ModuleImportKind;
	resolved: string | null;
	isLocal: boolean;
}

function normalizePath(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return path.normalize(filePath);
	}
}

function isInsideDir(filePath: string, dir: string): boolean {
	const relative = path.relative(dir, filePath);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isPathLike(specifier: string): boolean {
	return (
		specifier.startsWith('.') ||
		specifier.startsWith('/') ||
		/^[a-zA-Z]:[\\/]/.test(specifier)
	);
}

function stripWildcardSuffix(value: string): string {
	return value.endsWith('/*') ? value.slice(0, -2) : value;
}

function applyAlias(specifier: string, alias: Record<string, string> | undefined): string | null {
	if (!alias) return null;

	const entries = Object.entries(alias).sort((a, b) => b[0].length - a[0].length);
	for (const [rawKey, rawTarget] of entries) {
		const key = stripWildcardSuffix(rawKey);
		const target = stripWildcardSuffix(rawTarget);

		if (specifier === key || specifier.startsWith(`${key}/`)) {
			return `${target}${specifier.slice(key.length)}`;
		}
	}

	return null;
}

function resolveAliasPath(
	specifier: string,
	importerFile: string,
	projectRoot: string,
	alias: Record<string, string> | undefined
): string | null {
	const aliasedSpecifier = applyAlias(specifier, alias);
	if (!aliasedSpecifier) return null;

	if (isPathLike(aliasedSpecifier)) {
		const fromDir = path.isAbsolute(aliasedSpecifier)
			? path.dirname(aliasedSpecifier)
			: projectRoot;
		const targetSpecifier = path.isAbsolute(aliasedSpecifier)
			? aliasedSpecifier
			: path.relative(fromDir, path.resolve(projectRoot, aliasedSpecifier));

		return resolveExportPath(targetSpecifier, fromDir);
	}

	// Allow alias-to-package indirection, though this is uncommon.
	try {
		return createRequire(importerFile).resolve(aliasedSpecifier);
	} catch {
		return null;
	}
}

function isWorkspaceLocalPath(filePath: string, workspaceRoot: string): boolean {
	return isInsideDir(filePath, workspaceRoot) && !filePath.includes(`${path.sep}node_modules${path.sep}`);
}

export function resolveModulePath(
	specifier: string,
	importerFile: string,
	options: ResolveModulePathOptions
): ResolvedModulePath {
	const { projectRoot, workspaceRoot, alias, followPackageImports = false, resolveImport } = options;
	const importerDir = path.dirname(importerFile);

	if (resolveImport) {
		const customResolved = resolveImport(specifier, importerFile, {
			projectRoot,
			workspaceRoot,
		});
		if (customResolved) {
			const resolved = path.isAbsolute(customResolved)
				? resolveExportPath(customResolved, importerDir)
				: resolveExportPath(customResolved, importerDir);
			return {
				kind: 'custom',
				resolved,
				isLocal: Boolean(resolved),
			};
		}
	}

	if (specifier.startsWith('.')) {
		const resolved = resolveExportPath(specifier, importerDir);
		return {
			kind: 'relative',
			resolved,
			isLocal: Boolean(resolved),
		};
	}

	if (path.isAbsolute(specifier)) {
		const resolved = resolveExportPath(specifier, importerDir);
		return {
			kind: 'absolute',
			resolved,
			isLocal: Boolean(resolved),
		};
	}

	const resolvedAliasPath = resolveAliasPath(specifier, importerFile, projectRoot, alias);
	if (resolvedAliasPath) {
		return {
			kind: 'alias',
			resolved: normalizePath(resolvedAliasPath),
			isLocal: true,
		};
	}

	try {
		const resolved = normalizePath(createRequire(importerFile).resolve(specifier));
		const isWorkspaceLocal = isWorkspaceLocalPath(resolved, workspaceRoot);
		const isLocal =
			followPackageImports === 'all' ||
			((followPackageImports === true || followPackageImports === 'workspace') &&
				isWorkspaceLocal);

		return {
			kind: 'package',
			resolved,
			isLocal,
		};
	} catch {
		return {
			kind: 'package',
			resolved: null,
			isLocal: false,
		};
	}
}
