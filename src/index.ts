import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import chalk from 'chalk';
import fg from 'fast-glob';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createUnplugin } from 'unplugin';
import { collectMetadata, resetMetadata } from './collect-metadata';
import { inlineFunctions } from './inline-functions';
import { STATS } from './stats';
import { getBabelDefaultExport } from './utils/babel-exports';

const traverse = getBabelDefaultExport(_traverse);

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
	 *
	 * @default false
	 */
	debug?: boolean;

	/**
	 * Automatically discover files via `export * from` and `export { ... } from` statements.
	 * When enabled, files matching the include pattern will be scanned for export statements,
	 * and the referenced files will be automatically included in metadata collection.
	 *
	 * @default true
	 */
	followExports?: boolean;
}

const astCache = new Map<string, any>(); // hash -> ast
const codeCache = new Map<string, string>(); // hash -> transformed code

function hashContent(content: string): string {
	return createHash('md5').update(content).digest('hex');
}

function findProjectRoot(dir: string, originalDir: string = dir): string {
	if (fs.existsSync(path.join(dir, 'package.json'))) {
		return dir;
	}
	const parent = path.dirname(dir);
	if (parent === dir) {
		// Reached filesystem root without finding package.json
		// Return the original directory instead of filesystem root
		return originalDir;
	}
	return findProjectRoot(parent, originalDir);
}

/**
 * Find all files referenced via export statements in an AST.
 */
function findExportFromStatements(ast: any, filePath: string): string[] {
	const exportedFiles: string[] = [];
	const fileDir = path.dirname(filePath);

	traverse(ast, {
		ExportAllDeclaration(path: any) {
			if (path.node.source) {
				const sourcePath = path.node.source.value;
				if (typeof sourcePath === 'string' && sourcePath.startsWith('.')) {
					// Only follow relative paths
					const resolved = resolveExportPath(sourcePath, fileDir);
					if (resolved) exportedFiles.push(resolved);
				}
			}
		},
		ExportNamedDeclaration(path: any) {
			if (path.node.source) {
				const sourcePath = path.node.source.value;
				if (typeof sourcePath === 'string' && sourcePath.startsWith('.')) {
					// Only follow relative paths
					const resolved = resolveExportPath(sourcePath, fileDir);
					if (resolved) exportedFiles.push(resolved);
				}
			}
		},
	});

	return exportedFiles;
}

/**
 * Resolve an export path to an actual file path.
 * Tries various extensions and index files.
 */
function resolveExportPath(sourcePath: string, fromDir: string): string | null {
	// Resolve relative path
	const resolved = path.resolve(fromDir, sourcePath);

	// Try different extensions
	const extensions = ['.ts', '.tsx', '.js', '.jsx', ''];
	for (const ext of extensions) {
		const withExt = resolved + ext;
		if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
			return withExt;
		}
		// Also try /index files
		const indexPath = path.join(resolved, 'index' + ext);
		if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
			return indexPath;
		}
	}

	return null;
}

export const unplugin = createUnplugin<InlineFunctionsOptions | undefined>((options = {}) => {
	const {
		include = ['src/**/*.{js,ts,jsx,tsx}'],
		exclude = ['node_modules/**', '**/*.spec.ts', '**/*.test.ts', '**/*.spec.js', '**/*.test.js'],
		cwd = process.cwd(),
		debug = false,
		followExports = true,
	} = options;

	let initialized = false;
	const projectRoot = findProjectRoot(cwd);

	if (debug) {
		console.log(chalk.blue('[unplugin-inline-functions] Debug mode enabled'));
		console.log(chalk.blue(`  cwd: ${cwd}`));
		console.log(chalk.blue(`  projectRoot: ${projectRoot}`));
		console.log(chalk.blue(`  include: ${JSON.stringify(include)}`));
		console.log(chalk.blue(`  exclude: ${JSON.stringify(exclude)}`));
		console.log(chalk.blue(`  followExports: ${followExports}`));
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
		let files = new Set(
			fg.sync(includePatterns, {
				cwd: projectRoot,
				ignore: excludePatterns,
				absolute: true,
				onlyFiles: true,
			})
		);

		// Discover files via export * from statements if enabled
		if (followExports) {
			const visited = new Set<string>();
			const toProcess = Array.from(files);

			while (toProcess.length > 0) {
				const filePath = toProcess.shift()!;
				if (visited.has(filePath)) continue;
				visited.add(filePath);

				try {
					const contents = fs.readFileSync(filePath, 'utf8');
					const ast = parse(contents, {
						sourceType: 'module',
						plugins: ['typescript', 'jsx'],
						sourceFilename: filePath,
					});

					const exportedFiles = findExportFromStatements(ast, filePath);
					for (const exportedFile of exportedFiles) {
						// Check if file should be excluded
						// Use fast-glob to test if this file would be excluded
						const relativePath = path.relative(projectRoot, exportedFile);
						const normalizedPath = relativePath.replace(/\\/g, '/'); // Normalize path separators

						// Test if file matches any exclude pattern by checking if it would be included
						// when we use the exclude patterns as ignore
						const wouldBeIncluded =
							fg.sync([normalizedPath], {
								cwd: projectRoot,
								ignore: excludePatterns,
								absolute: false,
							}).length > 0;

						if (wouldBeIncluded && !files.has(exportedFile)) {
							files.add(exportedFile);
							toProcess.push(exportedFile);
						}
					}
				} catch (error) {
					// Skip files that fail to parse
					if (debug) {
						console.warn(
							chalk.yellow(
								`[unplugin-inline-functions] Failed to parse ${filePath} for export discovery: ${error}`
							)
						);
					}
				}
			}
		}

		const filesArray = Array.from(files);

		if (debug) {
			const initialCount = fg.sync(includePatterns, {
				cwd: projectRoot,
				ignore: excludePatterns,
				absolute: true,
				onlyFiles: true,
			}).length;
			const discoveredCount = filesArray.length - initialCount;
			console.log(
				chalk.blue(
					`[unplugin-inline-functions] Found ${
						filesArray.length
					} files matching include patterns${
						followExports && discoveredCount > 0
							? ` (+${discoveredCount} via exports)`
							: ''
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

		// Collect metadata from each file
		for (const filePath of filesArray) {
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
			} catch (error) {
				// Skip files that fail to parse
				console.warn(`Failed to parse ${filePath}:`, error);
			}
		}
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
			if (debug) {
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
				if (debug) {
					console.warn(
						chalk.yellow(
							`[unplugin-inline-functions] Warning: buildStart() was not called, initializing in transform() for file: ${id}`
						)
					);
				}
				scanAndCollectMetadata();
			}

			if (debug) {
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
