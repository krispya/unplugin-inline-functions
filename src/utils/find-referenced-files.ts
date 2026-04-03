import _traverse from '@babel/traverse';
import chalk from 'chalk';
import path from 'node:path';
import { getBabelDefaultExport } from './babel-exports';
import {
	FollowPackageImportsOption,
	ResolveImportHook,
	resolveModulePath,
} from './resolve-module-path';

const traverse = getBabelDefaultExport(_traverse);

export type FollowImportsOption = boolean | 'side-effects' | 'all' | 'none';
export type DebugOption = boolean | 'verbose' | undefined;

export interface ReferencedFile {
	type: 'export *' | 'export {...}' | 'import' | 'import (side-effect)';
	path: string;
	resolved: string | null;
}

/**
 * Find all files referenced via export and import statements in an AST.
 */
export function findReferencedFiles(
	ast: any,
	filePath: string,
	followImports: FollowImportsOption = false,
	debug: DebugOption = false,
	projectRoot: string = process.cwd(),
	workspaceRoot: string = projectRoot,
	followPackageImports: FollowPackageImportsOption = false,
	alias?: Record<string, string>,
	resolveImport?: ResolveImportHook
): string[] {
	const referencedFiles: string[] = [];
	const statements: ReferencedFile[] = [];

	traverse(ast, {
		ExportAllDeclaration(path: any) {
			if (path.node.source) {
				const sourcePath = path.node.source.value;
				if (typeof sourcePath === 'string') {
					const { resolved, isLocal } = resolveModulePath(sourcePath, filePath, {
						projectRoot,
						workspaceRoot,
						alias,
						followPackageImports,
						resolveImport,
					});
					statements.push({ type: 'export *', path: sourcePath, resolved });
					if (resolved && isLocal) referencedFiles.push(resolved);
				}
			}
		},
		ExportNamedDeclaration(path: any) {
			if (path.node.source) {
				const sourcePath = path.node.source.value;
				if (typeof sourcePath === 'string') {
					const { resolved, isLocal } = resolveModulePath(sourcePath, filePath, {
						projectRoot,
						workspaceRoot,
						alias,
						followPackageImports,
						resolveImport,
					});
					statements.push({ type: 'export {...}', path: sourcePath, resolved });
					if (resolved && isLocal) referencedFiles.push(resolved);
				}
			}
		},
		ImportDeclaration(path: any) {
			if (followImports === false || followImports === 'none') {
				return; // Don't follow imports
			}

			if (path.node.source) {
				const sourcePath = path.node.source.value;
				if (typeof sourcePath === 'string') {
					// Check if we should follow this import
					const isSideEffect = path.node.specifiers.length === 0;
					const shouldFollow =
						followImports === 'all' ||
						followImports === true ||
						(followImports === 'side-effects' && isSideEffect);

					if (shouldFollow) {
						const { resolved, isLocal } = resolveModulePath(sourcePath, filePath, {
							projectRoot,
							workspaceRoot,
							alias,
							followPackageImports,
							resolveImport,
						});
						const importType = isSideEffect ? 'import (side-effect)' : 'import';
						statements.push({ type: importType, path: sourcePath, resolved });
						if (resolved && isLocal) referencedFiles.push(resolved);
					}
				}
			}
		},
	});

	const isVerbose = debug === 'verbose';
	if (isVerbose && statements.length > 0) {
		for (const stmt of statements) {
			if (stmt.resolved) {
				const resolvedRelative = path.relative(projectRoot, stmt.resolved);
				console.log(
					chalk.gray(
						`[unplugin-inline-functions]       ${stmt.type} from "${stmt.path}" → ${resolvedRelative}`
					)
				);
			} else {
				console.log(
					chalk.yellow(
						`[unplugin-inline-functions]       ${stmt.type} from "${stmt.path}" → (not found)`
					)
				);
			}
		}
	}

	return referencedFiles;
}
