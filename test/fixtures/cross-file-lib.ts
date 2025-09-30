// Function marked as @inline - should be discovered in first pass
export /* @inline */ function crossFileHelper(x: number) {
	return x * 2 + 10;
}

// Another inline function to make it more interesting
export /* @inline */ function doubleValue(n: number) {
	return n * 2;
}
