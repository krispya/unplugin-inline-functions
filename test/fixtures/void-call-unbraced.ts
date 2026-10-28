/* @inline */ function bump(counter: { value: number }) {
	counter.value++;
}

export function bumpIf(counter: { value: number }, enabled: boolean) {
	if (enabled) bump(counter);
	return counter.value;
}

export function bumpElse(counter: { value: number }, skip: boolean) {
	if (skip) counter.value--;
	else bump(counter);
	return counter.value;
}

export function bumpLoop(counter: { value: number }, times: number) {
	for (let i = 0; i < times; i++) bump(counter);
	return counter.value;
}

/* @inline */ function scaled(value: number, factor: number) {
	const result = value * factor;
	return result;
}

export function sumScaled(times: number) {
	let total = 0;
	for (let i = 0; i < times; i++) total += scaled(i, 2);
	return total;
}
