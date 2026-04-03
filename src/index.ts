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
import { findWorkspaceRoot } from './utils/find-workspace-root';
import {
	logFileDiscovery,
	logMetadataCollectionForFile,
	logMetadataCollectionSummary,
} from './utils/debug-logging';
import {
	FollowPackageImportsOption,
	ResolveImportHook,
} from './utils/resolve-module-path';
import { resetResolutionConfig, setResolutionConfig } from './utils/resolution-config';

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
	 * Workspace root for resolving local package imports.
	 * Falls back to an auto-detected workspace root when omitted.
	 */
	workspaceRoot?: string;

	/**
	 * Alias map used when discovering files and rewriting injected imports.
	 *
	 * @example { '@': './src' }
	 * @example { '@/*': './src/*' }
	 */
	alias?: Record<string, string>;

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

	/**
	 * Follow bare package imports during discovery.
	 *
	 * - `false`: Never follow package imports
	 * - `'workspace'` or `true`: Only follow package imports that resolve to local workspace files
	 * - `'all'`: Follow any resolvable package import, including node_modules
	 *
	 * @default 'workspace'
	 */
	followPackageImports?: FollowPackageImportsOption;

	/**
	 * Custom resolver used by file discovery and injected-import rewriting.
	 * Return an absolute file path to a source module when the plugin should treat
	 * an import as local source.
	 */
	resolveImport?: ResolveImportHook;
}

const astCache = new Map<string, any>(); // hash -> ast
const codeCache = new Map<string, string>(); // hash -> transformed code

function hashContent(content: string): string {
	return createHash('md5').update(content).digest('hex');
}

function realpathSafe(filePath: string): string {
	try {
		return fs.realpathSync(filePath);
	} catch {
		return filePath;
	}
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
		workspaceRoot,
		alias,
		debug = false,
		followExports = true,
		followImports = true,
		followPackageImports = 'workspace',
		resolveImport,
	} = options;

	let initialized = false;
	const projectRoot = realpathSafe(findProjectRoot(cwd));
	const detectedWorkspaceRoot = realpathSafe(workspaceRoot || findWorkspaceRoot(projectRoot));

	if (isDebugEnabled(debug)) {
		if (isVerboseDebug(debug)) {
			console.log(chalk.blue('[unplugin-inline-functions] Debug mode enabled (verbose)'));
			console.log(chalk.blue(`  cwd: ${cwd}`));
			console.log(chalk.blue(`  projectRoot: ${projectRoot}`));
			console.log(chalk.blue(`  workspaceRoot: ${detectedWorkspaceRoot}`));
			console.log(chalk.blue(`  include: ${JSON.stringify(include)}`));
			console.log(chalk.blue(`  exclude: ${JSON.stringify(exclude)}`));
			console.log(chalk.blue(`  followExports: ${followExports}`));
			console.log(chalk.blue(`  followImports: ${followImports}`));
			console.log(chalk.blue(`  followPackageImports: ${followPackageImports}`));
			if (alias) {
				console.log(chalk.blue(`  alias: ${JSON.stringify(alias)}`));
			}
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
		resetResolutionConfig();
		astCache.clear();
		codeCache.clear();
		setResolutionConfig({
			projectRoot,
			workspaceRoot: detectedWorkspaceRoot,
			alias,
			followPackageImports,
			resolveImport,
		});

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
			workspaceRoot: detectedWorkspaceRoot,
			excludePatterns,
			debug,
			followExports: followExports || false,
			followImports,
			followPackageImports,
			alias,
			resolveImport,
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
