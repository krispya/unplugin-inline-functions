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
			return fs.realpathSync(withExt);
		}
		// Also try /index files
		const indexPath = path.join(resolved, 'index' + ext);
		if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
			return fs.realpathSync(indexPath);
		}
	}
	// TypeScript sources commonly import their eventual JavaScript filenames.
	const sourceExtension = /\.jsx?$/.exec(resolved);
	if (sourceExtension) {
		const typescriptPath =
			resolved.slice(0, -sourceExtension[0].length) +
			(sourceExtension[0] === '.jsx' ? '.tsx' : '.ts');
		if (fs.existsSync(typescriptPath) && fs.statSync(typescriptPath).isFile()) {
			return fs.realpathSync(typescriptPath);
		}
	}

	return null;
}
