import { NodePath } from '@babel/traverse';
import { inlinableFunctions } from '../collect-metadata';
import { getModuleProgram } from './get-module-program';
import { getFunctionDependencyChain, getFunctionLocalDeps } from './collect-local-dependencies';
import { createRelativePath } from './create-relative-path';
import { getResolutionConfig } from './resolution-config';
import { resolveModulePath } from './resolve-module-path';
import {
	identifier,
	ImportDeclaration,
	importDeclaration,
	importSpecifier,
	stringLiteral,
} from '@babel/types';

export function addImportsForDependencies(
	path: NodePath,
	inlinePath: NodePath,
	name: string,
	inlinedImportPath?: string
) {
	const moduleProgram = getModuleProgram(path);
	const localDeps = getFunctionLocalDeps(name);
	const dependencyChain = getFunctionDependencyChain(name);
	const resolutionConfig = getResolutionConfig();

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

				if (sourceFilePath && resolutionConfig) {
					const resolution = resolveModulePath(inlinedImport.source.value, sourceFilePath, {
						projectRoot: resolutionConfig.projectRoot,
						workspaceRoot: resolutionConfig.workspaceRoot,
						alias: resolutionConfig.alias,
						followPackageImports: resolutionConfig.followPackageImports,
						resolveImport: resolutionConfig.resolveImport,
					});

					if (resolution.resolved && resolution.isLocal) {
						// Compute the relative path from the current file to the resolved dependency
						relativePath = createRelativePath(currentPath, resolution.resolved);
					} else {
						relativePath = inlinedImport.source.value;
					}
				} else {
					relativePath = inlinedImport.source.value;
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
