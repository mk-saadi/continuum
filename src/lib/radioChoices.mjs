// Roving focus for button-backed native-style radio groups, in DOM order.
export function nextRadioChoice(key, index, count) {
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
	if (key === "ArrowLeft" || key === "ArrowUp") return (index + count - 1) % count;
	return null;
}
