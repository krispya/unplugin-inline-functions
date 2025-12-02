import _traverse from '@babel/traverse';
import chalk from 'chalk';
import fg from 'fast-glob';
import path from 'node:path';
import { inlinableFunctions } from '../collect-metadata';
import { getBabelDefaultExport } from './babel-exports';
import { hasInlineDecorator } from './decorator-utils';

const traverse = getBabelDefaultExport(_traverse);

export interface DebugLoggingOptions {
	projectRoot: string;
	includePatterns: string[];
	excludePatterns: string[];
	filesArray: string[];
	debug: boolean;
}

/**
 * Log debug information about file discovery.
 */
export function logFileDiscovery(options: DebugLoggingOptions): void {
	const { projectRoot, includePatterns, excludePatterns, filesArray, debug } = options;

	if (!debug) return;

	const initialCount = fg.sync(includePatterns, {
		cwd: projectRoot,
		ignore: excludePatterns,
		absolute: true,
		onlyFiles: true,
	}).length;
	const discoveredCount = filesArray.length - initialCount;
	console.log(
		chalk.blue(
			`[unplugin-inline-functions] Found ${filesArray.length} files matching include patterns${
				discoveredCount > 0 ? ` (+${discoveredCount} via exports)` : ''
			}`
		)
	);
	if (filesArray.length === 0) {
		console.warn(
			chalk.yellow(
				`[unplugin-inline-functions] Warning: No files found matching patterns: ${JSON.stringify(
					includePatterns
				)}`
			)
		);
		console.warn(chalk.yellow(`  Project root: ${projectRoot}`));
	} else if (filesArray.length <= 10) {
		console.log(chalk.blue(`  Files: ${filesArray.join(', ')}`));
	}
}

/**
 * Log metadata collection progress for a single file.
 */
export function logMetadataCollectionForFile(
	filePath: string,
	ast: any,
	projectRoot: string,
	discoveredViaExports: Map<string, string[]>,
	debug: boolean
): void {
	if (!debug) return;

	const wasDiscovered = discoveredViaExports.has(filePath);
	const relativePath = path.relative(projectRoot, filePath);
	const sourceInfo = wasDiscovered
		? ` (discovered via: ${discoveredViaExports
				.get(filePath)!
				.map((f) => path.relative(projectRoot, f))
				.join(', ')})`
		: '';

	// Find functions with @inline in this file
	const inlineFunctions: string[] = [];
	traverse(ast, {
		FunctionDeclaration(path: any) {
			if (path.node.id && hasInlineDecorator(path.node)) {
				inlineFunctions.push(path.node.id.name);
			}
		},
		VariableDeclarator(path: any) {
			if (
				path.node.id &&
				path.node.id.type === 'Identifier' &&
				path.node.init &&
				(path.node.init.type === 'ArrowFunctionExpression' ||
					path.node.init.type === 'FunctionExpression')
			) {
				const init = path.node.init as any;
				if (hasInlineDecorator(path.node) || hasInlineDecorator(init)) {
					inlineFunctions.push(path.node.id.name);
				}
			}
		},
	});

	if (inlineFunctions.length > 0 || wasDiscovered) {
		const functionInfo =
			inlineFunctions.length > 0 ? ` [@inline functions: ${inlineFunctions.join(', ')}]` : '';
		console.log(
			chalk.cyan(`[unplugin-inline-functions]   ✓ ${relativePath}${sourceInfo}${functionInfo}`)
		);
	}
}

/**
 * Log metadata collection summary.
 */
export function logMetadataCollectionSummary(filesArray: string[], debug: boolean): void {
	if (!debug) return;

	const totalInlineFunctions = inlinableFunctions.size;
	console.log(
		chalk.blue(
			`[unplugin-inline-functions] Metadata collection complete. Found ${totalInlineFunctions} @inline function(s) across ${filesArray.length} file(s).`
		)
	);
}
