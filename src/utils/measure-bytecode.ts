import _generate from '@babel/generator';
import _traverse, { NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getBabelDefaultExport } from './babel-exports';
import { Constant, foldConstants } from './constant-folding';

const generate = getBabelDefaultExport(_generate);
const traverse = getBabelDefaultExport(_traverse);

/** A stable identity for a function across re-parses of the same source. */
export function functionKey(node: t.Function): string | undefined {
	const loc = node.loc;
	return loc ? `${loc.filename}:${loc.start.line}:${loc.start.column}` : undefined;
}

let unavailable = false;
/** Why the last measurement produced nothing, for debug output. */
export let lastMeasureFailure: string | undefined;

/** Whether this runtime can compile and report bytecode through a child process. */
export function canMeasureBytecode() {
	return !unavailable && Boolean(process.versions.node) && !process.versions.bun;
}

function collectFunctions(ast: t.Node) {
	const functions: t.Function[] = [];
	t.traverseFast(ast, (node) => {
		if (t.isFunction(node)) functions.push(node);
	});
	return functions;
}

/**
 * Rewrite a module copy into a script V8 can compile without running it. Types and
 * module syntax go away, and every function gets a unique name to report under.
 */
function prepareScript(ast: t.File, prefix: string, defines: Map<string, Constant>) {
	const copy = t.cloneNode(ast, true);
	const originals = collectFunctions(ast);
	const copies = collectFunctions(copy);
	if (originals.length !== copies.length) {
		lastMeasureFailure = 'function count changed while cloning';
		return;
	}
	// Bundlers drop branches on defined constants, so the measured code must too.
	if (defines.size) foldConstants(copy, defines);
	const markers = new Map<t.Node, string>();
	copies.forEach((node, index) => markers.set(node, `${prefix}${index}`));
	let unsupported = false;
	traverse(copy, {
		ImportDeclaration(path) {
			path.remove();
		},
		ExportAllDeclaration(path) {
			path.remove();
		},
		ExportNamedDeclaration(path) {
			if (path.node.declaration) path.replaceWith(path.node.declaration);
			else path.remove();
		},
		ExportDefaultDeclaration(path) {
			const declaration = path.node.declaration;
			if (t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration)) {
				if (!declaration.id) declaration.id = path.scope.generateUidIdentifier('default');
				path.replaceWith(declaration);
			} else if (t.isExpression(declaration))
				path.replaceWith(t.expressionStatement(declaration));
			else path.remove();
		},
		'TSTypeAnnotation|TSTypeParameterInstantiation|TSTypeParameterDeclaration|TSTypeAliasDeclaration|TSInterfaceDeclaration|TSDeclareFunction|TSDeclareMethod|TSImportEqualsDeclaration|TSExportAssignment|TSNamespaceExportDeclaration|TSIndexSignature|TSExpressionWithTypeArguments'(
			path: NodePath
		) {
			path.remove();
		},
		'TSAsExpression|TSTypeAssertion|TSNonNullExpression|TSSatisfiesExpression|TSInstantiationExpression'(
			path: NodePath
		) {
			path.replaceWith((path.node as t.TSAsExpression).expression);
		},
		TSParameterProperty(path) {
			path.replaceWith(path.node.parameter);
		},
		'TSEnumDeclaration|TSModuleDeclaration|JSXElement|JSXFragment'(path: NodePath) {
			unsupported = true;
			path.stop();
		},
		// An async wrapper would make V8 skip eager compilation of the declarations inside it.
		'AwaitExpression|ForOfStatement'(path: NodePath) {
			const awaits = path.isAwaitExpression() || (path.node as t.ForOfStatement).await;
			if (awaits && !path.getFunctionParent()) {
				unsupported = true;
				path.stop();
			}
		},
		MetaProperty(path) {
			path.replaceWith(t.identifier('__meta'));
		},
		Identifier(path) {
			path.node.optional = false;
		},
		'VariableDeclaration|ClassDeclaration|ClassProperty'(path: NodePath) {
			if ((path.node as { declare?: boolean }).declare) path.remove();
		},
		Class(path) {
			(path.node as t.ClassDeclaration).abstract = false;
			path.node.implements = null;
		},
		Function(path) {
			// A TypeScript `this` parameter is a type annotation, not a parameter.
			path.node.params = path.node.params.filter(
				(param) => !t.isIdentifier(param, { name: 'this' })
			);
			const marker = markers.get(path.node);
			if (!marker) return;
			const id = t.identifier(marker);
			const node = path.node;
			if (t.isFunctionDeclaration(node)) {
				node.id = id;
				// V8 only compiles a declaration eagerly when something refers to it.
				const container = path.parentPath;
				if (container.isBlockStatement() || container.isProgram())
					(container as NodePath<t.BlockStatement>).pushContainer(
						'body',
						t.expressionStatement(t.cloneNode(id))
					);
				else if (container.isSwitchCase())
					container.pushContainer('consequent', t.expressionStatement(t.cloneNode(id)));
			} else if (t.isFunctionExpression(node)) node.id = id;
			else if (t.isArrowFunctionExpression(node)) {
				const body = t.isBlockStatement(node.body)
					? node.body
					: t.blockStatement([t.returnStatement(node.body)]);
				path.replaceWith(t.functionExpression(id, node.params, body, false, node.async));
			} else if (
				t.isObjectMethod(node) ||
				(t.isClassMethod(node) && node.kind !== 'constructor')
			) {
				node.key = id;
				node.computed = false;
			}
		},
	});
	if (unsupported) {
		lastMeasureFailure = 'unsupported syntax (enum, namespace, JSX or top-level await)';
		return;
	}
	const code = generate(copy, { comments: false, compact: true }).code;
	return { originals, code: `(function ${prefix}wrap() {\n${code}\n});\n` };
}

/**
 * Compile modules eagerly in a child node process and read V8's bytecode length for
 * every function. Nothing executes. Returns one map per module, or undefined when the
 * runtime cannot report bytecode.
 */
export function measureBytecode(
	asts: t.File[],
	defines: Map<string, Constant> = new Map()
): Map<t.Function, number>[] | undefined {
	if (!canMeasureBytecode()) {
		lastMeasureFailure = 'this runtime cannot report bytecode';
		return;
	}
	lastMeasureFailure = undefined;
	const prepared = asts.map((ast, index) => prepareScript(ast, `__m${index}_`, defines));
	if (prepared.some((entry) => !entry)) return;
	const file = path.join(os.tmpdir(), `inline-measure-${randomBytes(6).toString('hex')}.js`);
	fs.writeFileSync(file, prepared.map((entry) => entry!.code).join(''));
	let stdout: string;
	try {
		const result = spawnSync(
			process.execPath,
			['--no-lazy', '--print-bytecode', '--print-bytecode-filter=*', file],
			{ encoding: 'utf8', maxBuffer: 1 << 30 }
		);
		if (result.error) {
			unavailable = true;
			lastMeasureFailure = `cannot spawn node: ${result.error.message}`;
			return;
		}
		if (result.status !== 0) {
			lastMeasureFailure = `node rejected the script: ${result.stderr.split('\n').slice(0, 3).join(' ')}`;
			return;
		}
		stdout = result.stdout;
	} finally {
		fs.rmSync(file, { force: true });
	}
	const sizes = new Map<string, number>();
	let name: string | undefined;
	for (const line of stdout.split('\n')) {
		const header = /generated bytecode for function: ([^ (]*)/.exec(line);
		if (header) name = header[1];
		const length = /Bytecode length: (\d+)/.exec(line);
		if (length && name) sizes.set(name, Number(length[1]));
	}
	return prepared.map((entry, index) => {
		const result = new Map<t.Function, number>();
		entry!.originals.forEach((node, position) => {
			const size = sizes.get(`__m${index}_${position}`);
			if (size !== undefined) result.set(node, size);
		});
		return result;
	});
}
