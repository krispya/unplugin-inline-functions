import { isThing } from './utils/is-thing';

export function doSomething(value: unknown) {
	if (isThing(value)) {
		return 'yes';
	}
	return 'no';
}

