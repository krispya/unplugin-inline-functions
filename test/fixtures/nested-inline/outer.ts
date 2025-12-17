import { checkMarker } from './inner';

// Outer @inline function that calls inner @inline function
/* @inline */ export function findMarked(items: any[]) {
	for (const item of items) {
		if (checkMarker(item)) {
			return item;
		}
	}
	return null;
}

