// Function that resizes an array if needed, then always assigns a value
export /* @inline */ function setArrayValue(
	array: (any | undefined)[],
	index: number,
	value: any
): void {
	// Ensure array is large enough
	if (index >= array.length) {
		array.length = index + 1;
	}
	// This should ALWAYS execute, regardless of whether we resized
	array[index] = value;
}

export function testSetArrayValue() {
	const array: (any | undefined)[] = [];
	const testValue = { value: 42 };

	// This will trigger the resize path (index >= length)
	// The bug causes the assignment to be skipped
	setArrayValue(array, 5, testValue);

	// This should always be true - the assignment should happen
	return array[5] === testValue;
}
