import { createTagged } from './subdir-barrel';
export function buildTagged(value: string): ReturnType<typeof createTagged> {
	return createTagged(value);
}

