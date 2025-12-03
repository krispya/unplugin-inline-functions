import _generate from '@babel/generator';
import _traverse, { NodePath } from '@babel/traverse';
import { cloneNode, Function, isIdentifier, Node } from '@babel/types';
import { getBabelDefaultExport } from './utils/babel-exports';

const generate = getBabelDefaultExport(_generate);
const traverse = getBabelDefaultExport(_traverse);

export function dedupVariables(transformedFunctions: Map<NodePath<Function>, { isPure: boolean }>) {
	for (let [functionPath, { isPure }] of transformedFunctions) {
		if (!isPure) continue;

		const expressionCounts = new Map<string, number>();
		const variableDeclarations = new Map<string, string>();
		const firstDeclarationForExpression = new Map<
			string,
			{ name: string; isInIfStatement: boolean }
		>();
		const variablesToReplace = new Map<string, string>();

		// Remove duplicate memory access expressions if it is safe to do so.
		traverse(
			functionPath.node,
			{
				VariableDeclarator(path) {
					// Handle variable declarations
					if (!isIdentifier(path.node.id)) return;
					const variableName = path.node.id.name;
					if (!variableName.endsWith('_$f')) return;

					// Only dedup const declarations
					if (path.parent.type !== 'VariableDeclaration' || path.parent.kind !== 'const') {
						return;
					}

					const init = path.node.init;
					if (!init) return;

					let clonedInit = cloneNode(init);

					// Remove nullish type annotations.
					if (clonedInit.type === 'TSNonNullExpression') {
						clonedInit = clonedInit.expression;
					}

					let code = generate(clonedInit).code;

					// Replace any known variable references.
					for (const [varName, replacement] of variableDeclarations.entries()) {
						code = code.replace(`${varName}.`, replacement);
					}

					variableDeclarations.set(variableName, code);
					let expressionCount = expressionCounts.get(code) || 0;
					expressionCount++;
					expressionCounts.set(code, expressionCount);

					// Check if current declaration is inside an if statement
					let parent: NodePath<Node> | null = path.parentPath;
					let isInIfStatement = false;
					while (parent) {
						if (parent.isIfStatement()) {
							isInIfStatement = true;
							break;
						}
						parent = parent.parentPath;
					}

					if (expressionCount > 1) {
						const firstDeclaration = firstDeclarationForExpression.get(code)!;

						// Only deduplicate if both declarations are in the same scope
						if (isInIfStatement === firstDeclaration.isInIfStatement) {
							// Only deduplicate if both are outside if statements
							if (!isInIfStatement) {
								variablesToReplace.set(variableName, firstDeclaration.name);
								// Remove the declaration from the ast.
								path.remove();
							}
						}
					} else {
						firstDeclarationForExpression.set(code, {
							name: variableName,
							isInIfStatement,
						});
					}
				},
			},
			functionPath.scope
		);

		// Replace variables with their first declaration.
		traverse(
			functionPath.node,
			{
				Identifier(path) {
					const name = path.node.name;
					if (variablesToReplace.has(name)) {
						path.node.name = variablesToReplace.get(name)!;
					}
				},
			},
			functionPath.scope
		);
	}
}
