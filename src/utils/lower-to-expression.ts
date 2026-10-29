import * as t from '@babel/types';
import { undefinedValue } from './prepare-inline-function';
import { terminates } from './restructure-returns';

function hasReturn(node: t.Node): boolean {
	let found = false;
	t.traverseFast(node, (child) => {
		if (t.isReturnStatement(child)) found = true;
	});
	return found;
}

function statementsOf(branch: t.Statement): t.Statement[] {
	return t.isBlockStatement(branch) ? branch.body : [branch];
}

function sequence(parts: t.Expression[]): t.Expression {
	return parts.length === 1 ? parts[0] : t.sequenceExpression(parts);
}

/**
 * Rewrite a straight-line statement list as one expression. Block bindings become
 * assignments to variables the caller declares ahead of the enclosing statement, so
 * the body must not contain closures that would observe a shared binding.
 */
export function lowerToExpression(statements: t.Statement[]) {
	const declared: t.Identifier[] = [];
	function lower(list: t.Statement[], value: boolean): t.Expression | null | undefined {
		const parts: t.Expression[] = [];
		for (let index = 0; index < list.length; index++) {
			const statement = list[index];
			if (t.isEmptyStatement(statement)) continue;
			if (t.isVariableDeclaration(statement)) {
				if (statement.kind !== 'const' && statement.kind !== 'let') return;
				for (const declaration of statement.declarations) {
					declared.push(...Object.values(t.getBindingIdentifiers(declaration.id)));
					if (declaration.init)
						parts.push(
							t.assignmentExpression('=', declaration.id as t.LVal, declaration.init)
						);
				}
				continue;
			}
			if (t.isExpressionStatement(statement)) {
				parts.push(statement.expression);
				continue;
			}
			if (t.isReturnStatement(statement)) {
				if (!value) return;
				parts.push(statement.argument || undefinedValue());
				return sequence(parts);
			}
			if (t.isBlockStatement(statement) || t.isIfStatement(statement)) {
				const branches = t.isIfStatement(statement)
					? [statement.consequent, statement.alternate]
					: [statement];
				const exits = branches.map((branch) => branch && terminates(branch));
				const rest = list.slice(index + 1);
				if (value && exits.some(Boolean)) {
					// Returning branches take the value. Other paths continue with the remainder.
					const lowered = branches.map((branch, position) => {
						if (!branch) return lower(rest, true);
						if (exits[position]) return lower(statementsOf(branch), true);
						if (hasReturn(branch)) return;
						const effects = lower(statementsOf(branch), false);
						const remainder = lower(rest, true);
						if (effects === undefined || !remainder) return;
						return effects ? sequence([effects, remainder]) : remainder;
					});
					if (lowered.some((expression) => !expression)) return;
					parts.push(
						t.isIfStatement(statement)
							? t.conditionalExpression(statement.test, lowered[0]!, lowered[1]!)
							: lowered[0]!
					);
					return sequence(parts);
				}
				if (branches.some((branch) => branch && hasReturn(branch))) return;
				const lowered = branches.map((branch) =>
					branch ? lower(statementsOf(branch), false) : null
				);
				if (lowered.some((expression) => expression === undefined)) return;
				if (t.isIfStatement(statement))
					parts.push(
						t.conditionalExpression(
							statement.test,
							lowered[0] || undefinedValue(),
							lowered[1] || undefinedValue()
						)
					);
				else if (lowered[0]) parts.push(lowered[0]);
				continue;
			}
			return;
		}
		if (!value) return parts.length ? sequence(parts) : null;
		parts.push(undefinedValue());
		return sequence(parts);
	}
	const expression = lower(statements, true);
	return expression ? { expression, declared } : undefined;
}
