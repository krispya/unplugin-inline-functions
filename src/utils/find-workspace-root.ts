import fs from 'node:fs';
import path from 'node:path';

function hasWorkspacePackageJson(dir: string): boolean {
	const packageJsonPath = path.join(dir, 'package.json');
	if (!fs.existsSync(packageJsonPath)) return false;

	try {
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
		return Boolean(packageJson.workspaces);
	} catch {
		return false;
	}
}

/**
 * Find the workspace root by looking for common monorepo markers.
 * Falls back to the nearest package.json directory.
 */
export function findWorkspaceRoot(dir: string, originalDir: string = dir): string {
	let currentDir = dir;
	let fallbackDir = originalDir;

	while (true) {
		if (
			fs.existsSync(path.join(currentDir, 'pnpm-workspace.yaml')) ||
			fs.existsSync(path.join(currentDir, '.git')) ||
			hasWorkspacePackageJson(currentDir)
		) {
			return currentDir;
		}

		if (fs.existsSync(path.join(currentDir, 'package.json'))) {
			fallbackDir = currentDir;
		}

		const parent = path.dirname(currentDir);
		if (parent === currentDir) {
			return fallbackDir;
		}

		currentDir = parent;
	}
}
