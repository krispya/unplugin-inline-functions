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
}

const astCache = new Map<string, any>(); // hash -> ast
const codeCache = new Map<string, string>(); // hash -> transformed code

function hashContent(content: string): string {
	return createHash('md5').update(content).digest('hex');
}

function findProjectRoot(dir: string): string {
	if (fs.existsSync(path.join(dir, 'package.json'))) {
		return dir;
	}
	const parent = path.dirname(dir);
	if (parent === dir) return dir; // reached filesystem root
	return findProjectRoot(parent);
}

export const unplugin = createUnplugin<InlineFunctionsOptions | undefined>((options = {}) => {
	const {
		include = ['src/**/*.{js,ts,jsx,tsx}'],
		exclude = ['node_modules/**', '**/*.spec.ts', '**/*.test.ts', '**/*.spec.js', '**/*.test.js'],
		cwd = process.cwd(),
	} = options;

	let initialized = false;
	const projectRoot = findProjectRoot(cwd);

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
		const files = fg.sync(includePatterns, {
			cwd: projectRoot,
			ignore: excludePatterns,
			absolute: true,
			onlyFiles: true,
		});

		// Collect metadata from each file
		for (const filePath of files) {
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
			scanAndCollectMetadata();
		},

		transform(code: string, id: string) {
			// Only transform JS/TS files
			if (!/\.(js|ts|jsx|tsx)$/.test(id)) {
				return null;
			}

			// Ensure metadata is collected (in case buildStart wasn't called)
			if (!initialized) {
				scanAndCollectMetadata();
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
