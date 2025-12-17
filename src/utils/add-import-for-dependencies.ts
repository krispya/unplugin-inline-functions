import { NodePath } from '@babel/traverse';
import { getModuleProgram } from './get-module-program';
import { getFunctionDependencyChain, getFunctionLocalDeps } from './collect-local-dependencies';
import { createRelativePath } from './create-relative-path';
import { resolveExportPath } from './resolve-export-path';
import { inlinableFunctions } from '../collect-metadata';
import {
	identifier,
	ImportDeclaration,
	importDeclaration,
	importSpecifier,
	stringLiteral,
} from '@babel/types';
import nodePath from 'node:path';

export function addImportsForDependencies(
	path: NodePath,
	inlinePath: NodePath,
	name: string,
	inlinedImportPath?: string
) {
	const moduleProgram = getModuleProgram(path);
	const localDeps = getFunctionLocalDeps(name);
	const dependencyChain = getFunctionDependencyChain(name);

	if (localDeps && localDeps.size > 0 && moduleProgram) {
		for (const [depName, dep] of localDeps) {
			const currentPath = path.node.loc?.filename;
			const importPath = dep.fullPath;
			if (!importPath || !currentPath) continue;

			// Check if the import already exists in the file where transformed code is.
			const importExists = moduleProgram.body.some(
				(node) =>
					node.type === 'ImportDeclaration' &&
					node.specifiers.some((spec) => spec.local.name === depName)
			);

			if (importExists) continue;

			// Check if the import already exists in the file where the inlined function is.
			const inlinedModuleProgram = getModuleProgram(inlinePath);
			const inlinedImportExists = inlinedModuleProgram?.body.some(
				(node) =>
					node.type === 'ImportDeclaration' &&
					node.specifiers.some((spec) => spec.local.name === depName)
			);

			let relativePath: string;

			if (inlinedImportExists) {
				const inlinedImport = inlinedModuleProgram?.body.find(
					(node) =>
						node.type === 'ImportDeclaration' &&
						node.specifiers.some((spec) => spec.local.name === depName)
				) as ImportDeclaration;

				// Get the actual source file location of the inlined function
				const sourceFilePath = inlinePath.node.loc?.filename;

				if (sourceFilePath) {
					// Resolve the relative import to an absolute path using the source file's directory
					const sourceDir = nodePath.dirname(sourceFilePath);
					const resolvedDepPath = resolveExportPath(inlinedImport.source.value, sourceDir);

					if (resolvedDepPath) {
						// Compute the relative path from the current file to the resolved dependency
						relativePath = createRelativePath(currentPath, resolvedDepPath);
					} else {
						// Fallback: use createRelativePath with the full import path
						relativePath = createRelativePath(currentPath, importPath);
					}
				} else {
					relativePath = createRelativePath(currentPath, importPath);
				}
			} else {
				relativePath = createRelativePath(currentPath, importPath);
			}

			// Create an import declaration for each local dependency and add it to the program.
			const importDecl = importDeclaration(
				[importSpecifier(identifier(depName), identifier(depName))],
				stringLiteral(relativePath)
			);

			// Insert at the start of the program.
			moduleProgram.body.unshift(importDecl);
		}
	}

	if (dependencyChain.size > 0) {
		for (const funcName of dependencyChain) {
			// Get the actual path for the nested inlined function, not the parent's path
			const nestedFunc = inlinableFunctions.get(funcName);
			const nestedInlinePath = nestedFunc?.path ?? inlinePath;
			addImportsForDependencies(path, nestedInlinePath, funcName, inlinedImportPath);
		}
	}
}
