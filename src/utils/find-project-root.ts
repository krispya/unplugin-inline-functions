import fs from 'node:fs';
import path from 'node:path';

/**
 * Find the project root by looking for package.json.
 * Returns the original directory if no package.json is found.
 */
export function findProjectRoot(dir: string, originalDir: string = dir): string {
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
