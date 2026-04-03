/* @inline */
export function resolve(input: Record<string, any> | { wrapped: Record<string, any> }) {
	const ctx = 'value' in input ? input : input.wrapped;
	return ctx;
}
