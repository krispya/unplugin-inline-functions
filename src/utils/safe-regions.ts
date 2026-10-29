import { Binding, NodePath, Scope } from '@babel/traverse';
import * as t from '@babel/types';
import { bindingKey } from '../collect-metadata';

// Tokens represent runtime value identity, never generated source text or variable names.
type Value = object;
export interface ReadLocation {
	object: Value;
	key: string;
}
export type WriteLocation = ReadLocation | { binding: Binding };
interface Evaluation {
	value: Value;
	pure: boolean;
	read?: ReadLocation;
}
interface RegionVisitor {
	barrier?(): void;
	read?(location: ReadLocation): void;
	readBinding?(binding: Binding): void;
	write?(path: NodePath<t.AssignmentExpression>, location: WriteLocation): void;
	declaration?(path: NodePath<t.VariableDeclarator>, evaluation: Evaluation): void;
}

/** A property name, or a token for a constant binding used as a computed key such as a symbol. */
function propertyKey(node: t.Node, computed: boolean, scope: Scope): string | undefined {
	if (!computed && t.isIdentifier(node)) return node.name;
	if (t.isStringLiteral(node) || t.isNumericLiteral(node)) return String(node.value);
	if (!computed || !t.isIdentifier(node)) return undefined;
	const binding = scope.getBinding(node.name);
	if (!binding?.constant || !['const', 'module'].includes(binding.kind)) return undefined;
	const key = bindingKey(binding.identifier);
	return key && `\0${key}`;
}

/** Facts expire at any operation that might observe or mutate memory, throw, or suspend. */
class Region {
	bindings = new Map<Binding, Value>();
	objects = new Map<Value, Map<string, Value>>();
	constructor(
		readonly visitor: RegionVisitor,
		parent?: Region
	) {
		if (parent) {
			this.bindings = new Map(parent.bindings);
			this.objects = new Map(parent.objects);
		}
	}
	clear() {
		this.bindings.clear();
		this.objects.clear();
		this.visitor.barrier?.();
	}
	unknown(): Evaluation {
		this.clear();
		return { value: {}, pure: false };
	}
	evaluate(path: NodePath<t.Node>): Evaluation {
		if (
			path.isNumericLiteral() ||
			path.isStringLiteral() ||
			path.isBooleanLiteral() ||
			path.isNullLiteral() ||
			path.isBigIntLiteral() ||
			path.isFunctionExpression() ||
			path.isArrowFunctionExpression()
		)
			return { value: {}, pure: true };
		if (path.isIdentifier()) {
			const binding = path.scope.getBinding(path.node.name);
			const value = binding && this.bindings.get(binding);
			if (binding && value) this.visitor.readBinding?.(binding);
			// Includes unbound globals, live imports, TDZ reads, and unknown outer bindings.
			return value ? { value, pure: true } : this.unknown();
		}
		if (
			path.isTSNonNullExpression() ||
			path.isTSAsExpression() ||
			path.isTSTypeAssertion() ||
			path.isTSSatisfiesExpression() ||
			path.isParenthesizedExpression()
		)
			return this.evaluate(path.get('expression') as NodePath<t.Node>);
		if (path.isSequenceExpression()) {
			let pure = true;
			let result!: Evaluation;
			for (const expression of path.get('expressions')) {
				result = this.evaluate(expression);
				pure &&= result.pure;
			}
			return { ...result, pure };
		}
		if (path.isUnaryExpression() && ['void', '!', 'typeof'].includes(path.node.operator)) {
			const result = this.evaluate(path.get('argument'));
			return { value: {}, pure: result.pure };
		}
		if (path.isObjectExpression()) {
			const properties = new Map<string, Value>();
			let pure = true;
			for (const property of path.get('properties')) {
				// Reject accessors, spreads, methods, dynamic keys, and prototype setters.
				if (!property.isObjectProperty()) return this.unknown();
				const key = propertyKey(property.node.key, property.node.computed, property.scope);
				if (key === undefined || key === '__proto__') return this.unknown();
				const result = this.evaluate(property.get('value'));
				pure &&= result.pure;
				properties.set(key, result.value);
			}
			const value = {};
			// A fresh literal has writable own data properties even if an initializer had effects.
			this.objects.set(value, properties);
			return { value, pure };
		}
		if (path.isMemberExpression()) {
			const object = this.evaluate(path.get('object'));
			const key = propertyKey(path.node.property, path.node.computed, path.scope);
			const properties = this.objects.get(object.value);
			if (key === undefined || !properties?.has(key)) return this.unknown();
			const read = { object: object.value, key };
			this.visitor.read?.(read);
			return { value: properties.get(key)!, pure: object.pure, read };
		}
		// Calls (including @pure calls), stores, coercions, optional access, allocations
		// other than plain objects, await/yield, and unknown syntax end the region.
		return this.unknown();
	}

	/** Only standalone simple stores to initialized locals or known writable data slots. */
	assign(path: NodePath<t.AssignmentExpression>) {
		if (path.node.operator !== '=') return this.clear();
		const left = path.get('left');
		if (left.isIdentifier()) {
			const binding = left.scope.getBinding(left.node.name);
			if (!binding || !['let', 'var'].includes(binding.kind) || !this.bindings.has(binding))
				return this.clear();
			const result = this.evaluate(path.get('right'));
			if (!result.pure || !this.bindings.has(binding)) return this.clear();
			this.visitor.write?.(path, { binding });
			this.bindings.set(binding, result.value);
		} else if (left.isMemberExpression()) {
			const object = this.evaluate(left.get('object'));
			const key = propertyKey(left.node.property, left.node.computed, left.scope);
			const properties = this.objects.get(object.value);
			if (!object.pure || key === undefined || !properties?.has(key)) return this.clear();
			const result = this.evaluate(path.get('right'));
			// Unknown RHS effects could replace the descriptor or expose the old value.
			if (!result.pure || this.objects.get(object.value) !== properties) return this.clear();
			this.visitor.write?.(path, { object: object.value, key });
			const updated = new Map(properties);
			updated.set(key, result.value);
			this.objects.set(object.value, updated);
		} else this.clear();
	}
}

/** Analyze each statement list separately; never hoist across a control-flow boundary. */
export function visitSafeRegions(
	functions: Iterable<NodePath<t.Function>>,
	createVisitor: () => RegionVisitor
) {
	function visitList(statements: NodePath<t.Statement>[], parent?: Region) {
		const region = new Region(createVisitor(), parent);
		for (const statement of statements) {
			if (statement.isVariableDeclaration()) {
				if (!['const', 'let', 'var'].includes(statement.node.kind)) {
					region.clear();
					continue;
				}
				for (const declaration of statement.get('declarations')) {
					if (!t.isIdentifier(declaration.node.id)) {
						region.clear();
						continue;
					}
					const init = declaration.get('init');
					const result = init.node
						? region.evaluate(init as NodePath<t.Node>)
						: { value: {}, pure: true };
					region.visitor.declaration?.(declaration, result);
					const binding = declaration.scope.getBinding(declaration.node.id.name);
					if (binding) region.bindings.set(binding, result.value);
				}
			} else if (statement.isBlockStatement()) {
				visitList(statement.get('body'), region);
				region.clear();
			} else if (statement.isLabeledStatement() && statement.get('body').isBlockStatement()) {
				visitList((statement.get('body') as NodePath<t.BlockStatement>).get('body'), region);
				region.clear();
			} else if (statement.isExpressionStatement()) {
				const expression = statement.get('expression');
				if (region.visitor.write && expression.isAssignmentExpression())
					region.assign(expression);
				else region.evaluate(expression);
			} else if (!statement.isEmptyStatement() && !statement.isFunctionDeclaration()) {
				region.clear();
				// Branch, loop, catch, and finally bodies start without inherited facts.
				// Loop iterations cannot reuse the previous iteration's snapshot.
				statement.traverse({
					Function(path) {
						path.skip();
					},
					BlockStatement(path) {
						visitList(path.get('body'));
						path.skip();
					},
				});
			}
		}
	}
	const paths = [...functions];
	const programs = new Set(paths.map((path) => path.scope.getProgramParent()));
	for (const program of programs) program.crawl();
	for (const path of paths) {
		if (!path.get('body').isBlockStatement()) continue;
		let dynamic = false;
		path.traverse({
			Function(path) {
				path.skip();
			},
			WithStatement() {
				dynamic = true;
			},
			CallExpression(path) {
				if (t.isIdentifier(path.node.callee, { name: 'eval' })) dynamic = true;
			},
		});
		if (!dynamic) visitList((path.get('body') as NodePath<t.BlockStatement>).get('body'));
	}
}
