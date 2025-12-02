import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve an export/import path to an actual file path.
 * Tries various extensions and index files.
 */
export function resolveExportPath(sourcePath: string, fromDir: string): string | null {
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
