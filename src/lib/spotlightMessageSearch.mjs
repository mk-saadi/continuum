// A database pass has a short time budget to keep the main process responsive.
// Continue those passes automatically; a time slice is not a page of results.
export async function searchMessagePage(search, query, { cursor = null, isCurrent = () => true, pageSize = 5 } = {}) {
	const matches = [];
	const seen = new Set();
	let next = cursor;
	do {
		if (!isCurrent()) return null;
		const page = await search({ query, cursor: next });
		if (!isCurrent()) return null;
		for (const match of page.matches) {
			if (!seen.has(match.id)) { seen.add(match.id); matches.push(match); }
		}
		if (page.cursor != null && page.cursor === next) throw new Error('Message search could not advance. Please try again.');
		next = page.cursor ?? null;
	} while (next !== null && matches.length < pageSize);
	return { matches, cursor: next };
}
