import { parse } from '@babel/parser';
import chalk from 'chalk';
import fg from 'fast-glob';
import fs from 'node:fs';
import path from 'node:path';
import { findReferencedFiles, FollowImportsOption } from './find-referenced-files';

export type DebugOption = boolean | 'verbose' | undefined;

export interface DiscoveryOptions {
	projectRoot: string;
	excludePatterns: string[];
	debug: DebugOption;
	followExports: boolean;
	followImports: FollowImportsOption;
}

/**
 * Check if verbose debug mode is enabled
 */
function isVerboseDebug(debug: DebugOption): boolean {
	return debug === 'verbose';
}

export interface DiscoveryResult {
	files: Set<string>;
	discoveredViaExports: Map<string, string[]>; // file -> [sources that led to it]
}

/**
 * Discover files via export and import statements.
 */
export function discoverFilesViaReferences(
	initialFiles: Set<string>,
	options: DiscoveryOptions
): DiscoveryResult {
	const { projectRoot, excludePatterns, debug, followExports, followImports } = options;
	const discoveredViaExports = new Map<string, string[]>();
	const files = new Set(initialFiles);

	if (!followExports && followImports === false) {
		return { files, discoveredViaExports };
	}

	if (isVerboseDebug(debug)) {
		console.log(chalk.blue('[unplugin-inline-functions] Starting export discovery...'));
	}

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

			const referencedFiles = findReferencedFiles(
				ast,
				filePath,
				followImports,
				debug,
				projectRoot
			);

			if (isVerboseDebug(debug) && referencedFiles.length > 0) {
				const relativePath = path.relative(projectRoot, filePath);
				console.log(
					chalk.cyan(
						`[unplugin-inline-functions]   ${relativePath} exports from ${referencedFiles.length} file(s)`
					)
				);
			}

			for (const referencedFile of referencedFiles) {
				// Check if file should be excluded
				const relativePath = path.relative(projectRoot, referencedFile);
				const normalizedPath = relativePath.replace(/\\/g, '/'); // Normalize path separators

				// Test if file matches any exclude pattern by checking if it would be included
				// when we use the exclude patterns as ignore
				const wouldBeIncluded =
					fg.sync([normalizedPath], {
						cwd: projectRoot,
						ignore: excludePatterns,
						absolute: false,
					}).length > 0;

				if (wouldBeIncluded && !files.has(referencedFile)) {
					files.add(referencedFile);
					toProcess.push(referencedFile);

					// Track discovery chain
					const sources = discoveredViaExports.get(referencedFile) || [];
					sources.push(filePath);
					discoveredViaExports.set(referencedFile, sources);

					if (isVerboseDebug(debug)) {
						const referencedRelative = path.relative(projectRoot, referencedFile);
						const sourceRelative = path.relative(projectRoot, filePath);
						console.log(
							chalk.green(
								`[unplugin-inline-functions]     → Discovered: ${referencedRelative} (via ${sourceRelative})`
							)
						);
					}
				} else if (isVerboseDebug(debug) && !wouldBeIncluded) {
					const referencedRelative = path.relative(projectRoot, referencedFile);
					console.log(
						chalk.gray(
							`[unplugin-inline-functions]     → Skipped (excluded): ${referencedRelative}`
						)
					);
				}
			}
		} catch (error) {
			// Skip files that fail to parse
			if (isVerboseDebug(debug)) {
				const relativePath = path.relative(projectRoot, filePath);
				console.warn(
					chalk.yellow(
						`[unplugin-inline-functions] Failed to parse ${relativePath} for export discovery: ${error}`
					)
				);
			}
		}
	}

	if (isVerboseDebug(debug)) {
		console.log(
			chalk.blue(
				`[unplugin-inline-functions] Export discovery complete. Discovered ${discoveredViaExports.size} additional file(s).`
			)
		);
	}

	return { files, discoveredViaExports };
}
