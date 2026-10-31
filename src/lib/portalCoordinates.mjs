// Menus use viewport measurements, but a filtered dialog establishes the
// containing block for fixed descendants portaled into its top-layer subtree.
export function fixedPortalPosition(position, owner) {
	if (!owner) return position;
	const style = getComputedStyle(owner);
	if (style.backdropFilter === "none" && style.filter === "none" && style.transform === "none") return position;
	const rect = owner.getBoundingClientRect();
	return {
		...position,
		left: position.left - rect.left - owner.clientLeft + owner.scrollLeft,
		top: position.top - rect.top - owner.clientTop + owner.scrollTop,
	};
}
