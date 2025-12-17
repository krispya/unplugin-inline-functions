import { $tag } from './symbols';
import { validateTag } from './validate';

export /* @inline */ function createTagged(value: string) {
	if (!validateTag(value)) return null;
	return { [$tag]: value };
}

