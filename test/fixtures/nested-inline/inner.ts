import { $marker } from './symbols';

// Inner @inline function with a dependency import
export /* @inline */ function checkMarker(value: unknown): boolean {
	return (value as any)?.[$marker] === true;
}

