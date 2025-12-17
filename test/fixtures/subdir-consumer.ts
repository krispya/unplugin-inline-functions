import { createRelation } from './subdir-barrel';
export function build(a: string): ReturnType<typeof createRelation> {
	return createRelation(a);
}
