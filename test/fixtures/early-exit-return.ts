// Function with early return that should preserve control flow when inlined
export /* @inline */ function processIfPositive(value: number, output: { value: number }): void {
	// Early return - subsequent code should only execute when condition is false
	if (value <= 0) {
		return;
	}
	// This should only execute when value > 0
	output.value = value * 2;
}

export function testEarlyExit() {
	const output = { value: 0 };

	// Early exit should prevent processing
	processIfPositive(-5, output);

	// Should still be 0 because early return prevented assignment
	return output.value === 0;
}
