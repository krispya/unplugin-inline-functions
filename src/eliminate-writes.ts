import { Binding, NodePath } from '@babel/traverse';
import * as t from '@babel/types';
import { ReadLocation, visitSafeRegions, WriteLocation } from './utils/safe-regions';

/** Remove only stores overwritten in the same region before any observer can run. */
export function eliminateWrites(functions: Iterable<NodePath<t.Function>>) {
	visitSafeRegions(functions, () => {
		const locals = new Map<Binding, () => void>();
		const properties = new Map<ReadLocation['object'], Map<string, () => void>>();
		function store(location: WriteLocation, remove: () => void) {
			if ('binding' in location) {
				locals.get(location.binding)?.();
				locals.set(location.binding, remove);
			} else {
				if (!properties.has(location.object)) properties.set(location.object, new Map());
				const slots = properties.get(location.object)!;
				slots.get(location.key)?.();
				slots.set(location.key, remove);
			}
		}
		return {
			barrier() {
				locals.clear();
				properties.clear();
			},
			read({ object, key }) {
				properties.get(object)?.delete(key);
			},
			readBinding(binding) {
				locals.delete(binding);
			},
			write(path, location) {
				store(location, () => path.parentPath.remove());
			},
			declaration(path, evaluation) {
				if (!path.node.init || !evaluation.pure) return;
				const binding = path.scope.getBinding((path.node.id as t.Identifier).name);
				if (!binding || !['let', 'var'].includes(binding.kind)) return;
				// Keep the binding and its initialization point; only drop its dead initializer.
				store({ binding }, () => path.get('init').remove());
			},
		};
	});
}
