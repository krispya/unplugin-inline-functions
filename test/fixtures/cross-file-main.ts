import { crossFileHelper, doubleValue } from './cross-file-lib';

export function calculate(value: number) {
	// This call should be inlined - proves two-pass works
	// because cross-file-lib.ts must be scanned first
	const result = crossFileHelper(value);
	return result + 5;
}

export function processNumbers(a: number, b: number) {
	// Multiple calls to test inlining
	return doubleValue(a) + doubleValue(b);
}
