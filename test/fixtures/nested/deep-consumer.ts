import { createRelation } from '../subdir-barrel';
export function buildDeep(a: string): ReturnType<typeof createRelation> {
	return createRelation(a);
}

