import _traverse from '@babel/traverse';
import chalk from 'chalk';
import fg from 'fast-glob';
import path from 'node:path';
import { inlinableFunctions, pureFunctions } from '../collect-metadata';
import { getBabelDefaultExport } from './babel-exports';
import { hasInlineDecorator } from './decorator-utils';

const traverse = getBabelDefaultExport(_traverse);

export type DebugOption = boolean | 'verbose' | undefined;

export interface DebugLoggingOptions {
	projectRoot: string;
	includePatterns: string[];
	excludePatterns: string[];
	filesArray: string[];
	debug: DebugOption;
}

/**
 * Check if debug mode is enabled (either true or 'verbose')
 */
function isDebugEnabled(debug: DebugOption): boolean {
	return debug === true || debug === 'verbose';
}

/**
 * Check if verbose debug mode is enabled
 */
function isVerboseDebug(debug: DebugOption): boolean {
	return debug === 'verbose';
}

/**
 * Log debug information about file discovery.
 */
export function logFileDiscovery(options: DebugLoggingOptions): void {
	const { projectRoot, includePatterns, excludePatterns, filesArray, debug } = options;

	if (!isDebugEnabled(debug)) return;

	const initialCount = fg.sync(includePatterns, {
		cwd: projectRoot,
		ignore: excludePatterns,
		absolute: true,
		onlyFiles: true,
	}).length;
	const discoveredCount = filesArray.length - initialCount;

	if (isVerboseDebug(debug)) {
		console.log(
			chalk.blue(
				`[unplugin-inline-functions] Found ${
					filesArray.length
				} files matching include patterns${
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
	} else {
		// Consolidated mode
		console.log(
			chalk.blue(
				`[unplugin-inline-functions] Found ${filesArray.length} file(s)${
					discoveredCount > 0 ? ` (+${discoveredCount} discovered)` : ''
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
		}
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
	debug: DebugOption
): void {
	if (!isVerboseDebug(debug)) return;

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
export function logMetadataCollectionSummary(filesArray: string[], debug: DebugOption): void {
	if (!isDebugEnabled(debug)) return;

	const totalInlineFunctions = inlinableFunctions.size;
	const totalPureFunctions = pureFunctions.size;

	// Collect all inline function names
	const inlineFunctionNames = Array.from(inlinableFunctions.keys()).sort();

	// Collect all pure function names
	const pureFunctionNames = Array.from(pureFunctions).sort();

	// Collect all function names (both inline and pure)
	const allFunctionNames = Array.from(
		new Set([...inlineFunctionNames, ...pureFunctionNames])
	).sort();

	if (isVerboseDebug(debug)) {
		console.log(
			chalk.blue(
				`[unplugin-inline-functions] Metadata collection complete. Found ${totalInlineFunctions} @inline function(s) and ${totalPureFunctions} @pure function(s) across ${filesArray.length} file(s).`
			)
		);

		// List all functions with their decorators
		if (allFunctionNames.length > 0) {
			console.log(chalk.cyan('\nFunctions:'));
			for (const name of allFunctionNames) {
				const tags: string[] = [];
				if (inlinableFunctions.has(name)) {
					tags.push(chalk.cyan('[inline]'));
				}
				if (pureFunctions.has(name)) {
					tags.push(chalk.yellow('[pure]'));
				}
				const tagsStr = tags.length > 0 ? ` ${tags.join(' ')}` : '';
				console.log(chalk.cyan(`  ${name}${tagsStr}`));
			}
		}
	} else {
		// Consolidated mode
		console.log(
			chalk.blue(
				`[unplugin-inline-functions] Found ${totalInlineFunctions} @inline function(s) and ${totalPureFunctions} @pure function(s) in ${filesArray.length} file(s)`
			)
		);

		// List all functions with their decorators
		if (allFunctionNames.length > 0) {
			const functionList = allFunctionNames
				.map((name) => {
					const tags: string[] = [];
					if (inlinableFunctions.has(name)) {
						tags.push(chalk.cyan('[inline]'));
					}
					if (pureFunctions.has(name)) {
						tags.push(chalk.yellow('[pure]'));
					}
					const tagsStr = tags.length > 0 ? ` ${tags.join(' ')}` : '';
					return `${chalk.cyan(name)}${tagsStr}`;
				})
				.join(', ');
			console.log(`  ${functionList}`);
		}
	}
}
