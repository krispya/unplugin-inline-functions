import { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { ReadLocation, visitSafeRegions } from './utils/safe-regions';

/** Reuse a const snapshot only within one proven-safe straight-line region. */
export function dedupVariables(functions: Iterable<NodePath<t.Function>>) {
	visitSafeRegions(functions, () => {
		const reads = new Map<ReadLocation['object'], Map<string, Binding>>();
		return {
			barrier() {
				reads.clear();
			},
			declaration(path, evaluation) {
				if (
					!evaluation.pure ||
					!evaluation.read ||
					!path.parentPath.isVariableDeclaration({ kind: 'const' })
				)
					return;
				const { object, key } = evaluation.read;
				const binding = path.scope.getBinding((path.node.id as t.Identifier).name)!;
				const previous = reads.get(object)?.get(key);
				// A same-spelled binding in a nested scope is a different value.
				if (previous && path.scope.getBinding(previous.identifier.name) === previous) {
					path.get('init').replaceWith(t.identifier(previous.identifier.name));
				} else {
					if (!reads.has(object)) reads.set(object, new Map());
					reads.get(object)!.set(key, binding);
				}
			},
		};
	});
}
