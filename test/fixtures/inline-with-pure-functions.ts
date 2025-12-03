export function generateNumber() {
	return Math.random();
}

// Functions marked with @inline @pure
export /* @inline @pure */ function addOneToGeneratedNumber(a: number) {
	const result = generateNumber();
	return result + a;
}

export function multiply(a: number, b: number) {
	return a * b;
}

export function inlineInReturnStatement(seed: number) {
	return multiply(addOneToGeneratedNumber(seed), 2);
}

export function inlineWithIfStatement(seed: number) {
	if (seed > 0) {
		return addOneToGeneratedNumber(seed);
	}

	return multiply(addOneToGeneratedNumber(seed), 2);
}
