// Function with 3 parameters but will be called with fewer arguments
export /* @inline */ function processData(a: number, b: number, c?: number) {
	// This function uses all three parameters
	const sum = a + b;
	const product = sum * (c ?? 1);
	return product;
}

export function testFunction() {
	// Calling with only 2 arguments when function expects 3
	// This will cause 'c' to be undefined in paramMappings
	return processData(10, 20); // Missing third argument!
}
