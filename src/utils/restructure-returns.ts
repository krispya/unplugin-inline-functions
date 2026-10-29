import { NodePath } from '@babel/traverse';
import * as t from '@babel/types';

export function terminates(statement: t.Statement): boolean {
	if (t.isReturnStatement(statement)) return true;
	if (t.isBlockStatement(statement))
		return statement.body.length > 0 && terminates(statement.body[statement.body.length - 1]);
	if (t.isIfStatement(statement))
		return (
			Boolean(statement.alternate) &&
			terminates(statement.consequent) &&
			terminates(statement.alternate!)
		);
	return false;
}

function statementsOf(statement: t.Statement): t.Statement[] {
	return t.isBlockStatement(statement) ? statement.body : [statement];
}

/** Move the statements after an early-returning branch into its other branch. */
export function restructureReturns(list: t.Statement[]) {
	for (let index = 0; index < list.length; index++) {
		const statement = list[index];
		if (t.isBlockStatement(statement)) {
			restructureReturns(statement.body);
			continue;
		}
		if (!t.isIfStatement(statement)) continue;
		const rest = list.slice(index + 1);
		const consequent = terminates(statement.consequent);
		const alternate = statement.alternate ? terminates(statement.alternate) : false;
		if (consequent && alternate) list.length = index + 1;
		else if (consequent && !statement.alternate && rest.length) {
			statement.alternate = t.blockStatement(rest);
			list.length = index + 1;
		} else if (alternate && !consequent && rest.length) {
			statement.consequent = t.blockStatement([...statementsOf(statement.consequent), ...rest]);
			list.length = index + 1;
		}
		if (t.isBlockStatement(statement.consequent)) restructureReturns(statement.consequent.body);
		if (statement.alternate && t.isBlockStatement(statement.alternate))
			restructureReturns(statement.alternate.body);
	}
}

/** A return that nothing follows on its way out of the body, so it needs no jump. */
export function isTerminal(
	returnPath: NodePath<t.ReturnStatement>,
	body: NodePath<t.BlockStatement>
) {
	let current: NodePath = returnPath;
	while (current !== body) {
		const parent = current.parentPath!;
		if (parent.isBlockStatement()) {
			if (current.key !== parent.node.body.length - 1) return false;
		} else if (!parent.isIfStatement() || current.key === 'test') return false;
		current = parent;
	}
	return true;
}
