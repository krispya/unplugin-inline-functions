import { parse } from '@babel/parser';
import chalk from 'chalk';
import fg from 'fast-glob';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createUnplugin } from 'unplugin';
import { collectMetadata, resetMetadata } from './collect-metadata';
import { inlineFunctions } from './inline-functions';
import { STATS } from './stats';
import { discoverFilesViaReferences } from './utils/discover-files';
import { findProjectRoot } from './utils/find-project-root';
import {
	logFileDiscovery,
	logMetadataCollectionForFile,
	logMetadataCollectionSummary,
} from './utils/debug-logging';

export interface InlineFunctionsOptions {
	/**
	 * Glob patterns to include for metadata collection.
	 * These files will be scanned for @inline and @pure decorators.
	 * Similar to tsconfig.json's "include" field.
	 *
	 * @default ['src/**\/*.{js,ts,jsx,tsx}']
	 * @example ['src/utils/**\/*.ts', 'src/lib/**\/*.ts']
	 */
	include?: string | string[];

	/**
	 * Glob patterns to exclude from metadata collection.
	 *
	 * @default ['node_modules/**', '**\/*.spec.ts', '**\/*.test.ts']
	 */
	exclude?: string | string[];

	/**
	 * Base directory for resolving glob patterns.
	 *
	 * @default process.cwd()
	 */
	cwd?: string;

	/**
	 * Enable debug logging to help diagnose issues.
	 * - `true`: Shows consolidated summary information
	 * - `'verbose'`: Shows detailed verbose logging
	 *
	 * @default false
	 */
	debug?: boolean | 'verbose';

	/**
	 * Automatically discover files via `export * from` and `export { ... } from` statements.
	 * When enabled, files matching the include pattern will be scanned for export statements,
	 * and the referenced files will be automatically included in metadata collection.
	 *
	 * @default true
	 */
	followExports?: boolean;

	/**
	 * Automatically discover files via `import` statements.
	 *
	 * - `false` or `'none'`: Don't follow imports (default)
	 * - `'side-effects'`: Only follow side-effect imports (e.g., `import './patch'`)
	 * - `'all'` or `true`: Follow all relative imports
	 *
	 * @default true
	 * @example
	 * // Only follow side-effect imports (for patch files)
	 * followImports: 'side-effects'
	 *
	 * // Follow all imports (more aggressive, may discover more files)
	 * followImports: 'all'
	 */
	followImports?: boolean | 'side-effects' | 'all' | 'none';
}

const astCache = new Map<string, any>(); // hash -> ast
const codeCache = new Map<string, string>(); // hash -> transformed code

function hashContent(content: string): string {
	return createHash('md5').update(content).digest('hex');
}

/**
 * Check if debug mode is enabled (either true or 'verbose')
 */
function isDebugEnabled(debug: boolean | 'verbose' | undefined): boolean {
	return debug === true || debug === 'verbose';
}

/**
 * Check if verbose debug mode is enabled
 */
function isVerboseDebug(debug: boolean | 'verbose' | undefined): boolean {
	return debug === 'verbose';
}

export const unplugin = createUnplugin<InlineFunctionsOptions | undefined>((options = {}) => {
	const {
		include = ['src/**/*.{js,ts,jsx,tsx}'],
		exclude = ['node_modules/**', '**/*.spec.ts', '**/*.test.ts', '**/*.spec.js', '**/*.test.js'],
		cwd = process.cwd(),
		debug = false,
		followExports = true,
		followImports = true,
	} = options;

	let initialized = false;
	const projectRoot = findProjectRoot(cwd);

	if (isDebugEnabled(debug)) {
		if (isVerboseDebug(debug)) {
			console.log(chalk.blue('[unplugin-inline-functions] Debug mode enabled (verbose)'));
			console.log(chalk.blue(`  cwd: ${cwd}`));
			console.log(chalk.blue(`  projectRoot: ${projectRoot}`));
			console.log(chalk.blue(`  include: ${JSON.stringify(include)}`));
			console.log(chalk.blue(`  exclude: ${JSON.stringify(exclude)}`));
			console.log(chalk.blue(`  followExports: ${followExports}`));
			console.log(chalk.blue(`  followImports: ${followImports}`));
		} else {
			console.log(chalk.blue('[unplugin-inline-functions] Debug mode enabled'));
		}
	}

	/**
	 * Scan all files matching the include patterns and collect metadata.
	 * This runs once before any transformation.
	 */
	function scanAndCollectMetadata() {
		if (initialized) return;
		initialized = true;

		// Reset state
		STATS.reset();
		resetMetadata();
		astCache.clear();
		codeCache.clear();

		// Convert include to array
		const includePatterns = Array.isArray(include) ? include : [include];
		const excludePatterns = Array.isArray(exclude) ? exclude : [exclude];

		// Find all files matching the patterns
		const initialFiles = new Set(
			fg.sync(includePatterns, {
				cwd: projectRoot,
				ignore: excludePatterns,
				absolute: true,
				onlyFiles: true,
			})
		);

		// Discover files via exports and imports if enabled
		const { files, discoveredViaExports } = discoverFilesViaReferences(initialFiles, {
			projectRoot,
			excludePatterns,
			debug,
			followExports: followExports || false,
			followImports,
		});

		const filesArray = Array.from(files);

		// Log file discovery
		logFileDiscovery({
			projectRoot,
			includePatterns,
			excludePatterns,
			filesArray,
			debug,
		});

		// Collect metadata from each file
		if (isVerboseDebug(debug)) {
			console.log(chalk.blue('[unplugin-inline-functions] Collecting metadata from files...'));
		}

		for (const filePath of filesArray) {
			// Skip non-JS/TS files
			if (!/\.(js|ts|jsx|tsx)$/.test(filePath)) continue;

			try {
				const contents = fs.readFileSync(filePath, 'utf8');
				const hash = hashContent(contents);

				const ast = parse(contents, {
					sourceType: 'module',
					plugins: ['typescript', 'jsx'],
					sourceFilename: filePath,
				});

				astCache.set(hash, ast);
				collectMetadata(ast);

				// Log metadata collection for this file
				logMetadataCollectionForFile(filePath, ast, projectRoot, discoveredViaExports, debug);
			} catch (error) {
				// Skip files that fail to parse
				if (isDebugEnabled(debug)) {
					const relativePath = path.relative(projectRoot, filePath);
					console.warn(
						chalk.yellow(
							`[unplugin-inline-functions] Failed to parse ${relativePath}: ${error}`
						)
					);
				} else {
					console.warn(`Failed to parse ${filePath}:`, error);
				}
			}
		}

		// Log metadata collection summary
		logMetadataCollectionSummary(filesArray, debug);
	}

	/**
	 * Log statistics about inlined functions.
	 */
	function logStats() {
		const counts = Array.from(STATS.getAllInlinedFunctionCounts()).filter(
			([name]) => name.trim() !== ''
		);
		if (counts.length > 0) {
			console.log(chalk.green('\n✓ Inlined functions:'));
			for (const [name, count] of counts) {
				console.log(`  ${chalk.cyan(name)}: ${chalk.bold(count)}`);
			}
		}

		const functions = Array.from(STATS.getAllTransformedFunctions()).filter(
			([name]) => name.trim() !== ''
		);

		if (functions.length > 0) {
			console.log(chalk.green('\n✓ Transformed functions:'));
			// Group functions into lines of 4.
			const chunkSize = 4;
			// Calculate max width for each column.
			const columnWidths = Array(chunkSize).fill(0);
			for (let i = 0; i < functions.length; i++) {
				const col = i % chunkSize;
				const [name, { isPure }] = functions[i];
				// Account for 2 extra characters if the function is pure (space + star)
				columnWidths[col] = Math.max(columnWidths[col], name.length + (isPure ? 2 : 0));
			}
			// Print in grid format.
			for (let i = 0; i < functions.length; i += chunkSize) {
				const chunk = functions.slice(i, i + chunkSize);
				const paddedChunk = chunk.map(([name, { isPure }], idx) =>
					(isPure ? chalk.yellow : chalk.cyan)(
						`${name}${isPure ? ' ★' : ''}`.padEnd(columnWidths[idx])
					)
				);
				console.log(`  ${paddedChunk.join('  ')}`);
			}
			console.log('');
		}
	}

	return {
		name: 'unplugin-inline-functions',

		buildStart() {
			// Scan all files and collect metadata before transformation starts
			if (isVerboseDebug(debug)) {
				console.log(chalk.blue('[unplugin-inline-functions] buildStart() called'));
			}
			scanAndCollectMetadata();
		},

		transform(code: string, id: string) {
			// Only transform JS/TS files
			if (!/\.(js|ts|jsx|tsx)$/.test(id)) {
				return null;
			}

			// Ensure metadata is collected (in case buildStart wasn't called)
			if (!initialized) {
				if (isDebugEnabled(debug)) {
					console.warn(
						chalk.yellow(
							`[unplugin-inline-functions] Warning: buildStart() was not called, initializing in transform() for file: ${id}`
						)
					);
				}
				scanAndCollectMetadata();
			}

			if (isVerboseDebug(debug)) {
				console.log(chalk.blue(`[unplugin-inline-functions] Transforming file: ${id}`));
			}

			const hash = hashContent(code);

			// Return cached result if available
			if (codeCache.has(hash)) {
				return {
					code: codeCache.get(hash)!,
				};
			}

			try {
				// Parse or use cached AST
				const ast =
					astCache.get(hash) ??
					parse(code, {
						sourceType: 'module',
						plugins: ['typescript', 'jsx'],
						sourceFilename: id,
					});

				// Transform the code
				const transformedCode = inlineFunctions(ast);
				codeCache.set(hash, transformedCode);

				return {
					code: transformedCode,
				};
			} catch (error) {
				console.error(`Failed to transform ${id}:`, error);
				return null;
			}
		},

		buildEnd() {
			// Log statistics after build completes
			logStats();
		},
	};
});

// Export for convenience
export const inlineFunctionsPlugin = unplugin.raw;
export default unplugin;
