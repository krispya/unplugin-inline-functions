export function checkCondition(value: any): boolean {
	return value && value.type === 'typeA';
}

/* @inline @pure */ function processTypeA(value: any) {
	const ctxA = value.internal;
	return ctxA.property;
}

/* @inline @pure */ function processTypeB(value: any) {
	const ctxB = value.internal;
	return ctxB.property;
}

export function processValue(value: any) {
	if (checkCondition(value)) processTypeA(value);
	return processTypeB(value);
}
