import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import * as t from '@babel/types';
import MagicString from 'magic-string';
import { getBabelDefaultExport } from './utils/babel-exports';

const traverse = getBabelDefaultExport(_traverse);

/**
 * V8 keeps a binding that a chunk exports in a module cell and reads the cell on every
 * use. An unexported binding that never changes folds into optimized code instead.
 * Exporting an alias leaves the chunk's own reads on a binding that folds, and importers
 * get the same value under the same name. Returns undefined when nothing qualifies.
 */
export function decoupleExports(code: string): MagicString | undefined {
	let ast;
	try {
		ast = parse(code, { sourceType: 'module', plugins: ['jsx'] });
	} catch {
		return;
	}
	const edits = new MagicString(code);
	let changed = false;
	traverse(ast, {
		Program(program) {
			for (const statement of program.get('body')) {
				const node = statement.node;
				if (!t.isExportNamedDeclaration(node) || node.source || node.declaration) continue;
				const aliases: string[] = [];
				const specifiers = node.specifiers.map((specifier) => {
					const text = code.slice(specifier.start!, specifier.end!);
					if (!t.isExportSpecifier(specifier)) return text;
					// An alias copies the value once, so the binding must never change.
					// An import can change whenever the module it comes from assigns it.
					const binding = program.scope.getBinding(specifier.local.name);
					if (!binding || !binding.constant || binding.kind === 'module') return text;
					const alias = program.scope.generateUid(`${specifier.local.name}$export`);
					aliases.push(`const ${alias} = ${specifier.local.name};`);
					const exported = specifier.exported;
					return `${alias} as ${code.slice(exported.start!, exported.end!)}`;
				});
				if (!aliases.length) continue;
				edits.overwrite(
					node.start!,
					node.end!,
					`${aliases.join('\n')}\nexport { ${specifiers.join(', ')} };`
				);
				changed = true;
			}
			program.stop();
		},
	});
	return changed ? edits : undefined;
}
