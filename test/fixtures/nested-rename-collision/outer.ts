import { resolve } from './inner';

/* @inline */
function process(ctx: Record<string, any>, key: string) {
	const resolved = resolve(ctx);
	return resolved[key];
}

export function run(ctx: Record<string, any>, key: string) {
	return process(ctx, key);
}
