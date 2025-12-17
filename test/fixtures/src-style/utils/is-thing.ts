import { $mySymbol } from '../symbols';

export /* @inline */ function isThing(value: unknown): boolean {
	return (value as any)?.[$mySymbol] === true;
}

