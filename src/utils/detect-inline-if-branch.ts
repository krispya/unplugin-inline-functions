import { NodePath } from '@babel/traverse';
import { CallExpression, IfStatement, isBlockStatement } from '@babel/types';

/**
 * Detects if a CallExpression is inside an IfStatement's consequent or alternate
 * that is not wrapped in a BlockStatement (i.e., an inline statement).
 * Returns information needed to properly insert inlined code.
 */
export function detectInlineIfBranch(
	callPath: NodePath<CallExpression>,
	statementPath: NodePath
): {
	needsWrapping: boolean;
	branch: 'consequent' | 'alternate' | null;
	ifPath: NodePath | null;
	ifNode: IfStatement | null;
} {
	if (!statementPath.isIfStatement()) {
		return { needsWrapping: false, branch: null, ifPath: null, ifNode: null };
	}

	const ifNode = statementPath.node;
	const consequent = ifNode.consequent;
	const alternate = ifNode.alternate;

	// Check if call is in consequent and consequent is not a block
	if (!isBlockStatement(consequent) && callPath.findParent((p) => p.node === consequent)) {
		return {
			needsWrapping: true,
			branch: 'consequent',
			ifPath: statementPath,
			ifNode: ifNode,
		};
	}

	// Check if call is in alternate and alternate is not a block
	if (
		alternate &&
		!isBlockStatement(alternate) &&
		callPath.findParent((p) => p.node === alternate)
	) {
		return {
			needsWrapping: true,
			branch: 'alternate',
			ifPath: statementPath,
			ifNode: ifNode,
		};
	}

	return { needsWrapping: false, branch: null, ifPath: null, ifNode: null };
}
