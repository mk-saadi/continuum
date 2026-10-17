// DOM helpers for in-chat find (Ctrl+F). Operates on the transcript scroll
// container directly: wraps case-insensitive matches in <span data-chat-find>
// so React re-renders stay untouched. Marks are cleared and re-applied on
// every query/transcript change, so streaming can never leave stale marks.

export const FIND_MARK_ATTR = "data-chat-find";
export const FIND_MARK_SELECTOR = "span[data-chat-find]";
export const MAX_FIND_MARKS = 500;

// Unwrap every find mark inside scope, restoring the original text nodes.
export function clearFindMarks(scopeEl) {
	if (!scopeEl || typeof scopeEl.querySelectorAll !== "function") return;
	const marks = scopeEl.querySelectorAll(FIND_MARK_SELECTOR);
	for (const mark of marks) {
		const parent = mark.parentNode;
		if (!parent) continue;
		while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
		parent.removeChild(mark);
		parent.normalize?.();
	}
}

// Collect text nodes eligible for marking (skips editable/media/script
// regions and existing marks).
function collectFindTextNodes(scopeEl) {
	const doc = scopeEl.ownerDocument;
	const walker = doc.createTreeWalker(scopeEl, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
			let parent = node.parentElement;
			while (parent && parent !== scopeEl) {
				const tag = parent.tagName;
				if (
					tag === "TEXTAREA" ||
					tag === "INPUT" ||
					tag === "SELECT" ||
					tag === "SCRIPT" ||
					tag === "STYLE" ||
					parent.hasAttribute?.(FIND_MARK_ATTR)
				)
					return NodeFilter.FILTER_REJECT;
				if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
				parent = parent.parentElement;
			}
			return NodeFilter.FILTER_ACCEPT;
		},
	});
	const nodes = [];
	while (walker.nextNode()) nodes.push(walker.currentNode);
	return nodes;
}

// Wrap every occurrence of query inside scope. Returns the live mark list.
// Case-insensitive; caps at MAX_FIND_MARKS to bound layout work.
export function applyFindMarks(scopeEl, query) {
	clearFindMarks(scopeEl);
	const needle = String(query ?? "").trim();
	if (!scopeEl || !needle) return [];
	const lowerNeedle = needle.toLowerCase();
	const doc = scopeEl.ownerDocument;
	const marks = [];
	for (const node of collectFindTextNodes(scopeEl)) {
		if (marks.length >= MAX_FIND_MARKS) break;
		const text = node.nodeValue;
		const lower = text.toLowerCase();
		let index = 0;
		let pos = lower.indexOf(lowerNeedle);
		if (pos === -1) continue;
		const fragment = doc.createDocumentFragment();
		while (pos !== -1 && marks.length < MAX_FIND_MARKS) {
			if (pos > index) fragment.appendChild(doc.createTextNode(text.slice(index, pos)));
			const mark = doc.createElement("span");
			mark.setAttribute(FIND_MARK_ATTR, "1");
			mark.setAttribute("data-active", "false");
			mark.className = "chat-find-mark";
			mark.textContent = text.slice(pos, pos + needle.length);
			fragment.appendChild(mark);
			marks.push(mark);
			index = pos + needle.length;
			pos = lower.indexOf(lowerNeedle, index);
		}
		fragment.appendChild(doc.createTextNode(text.slice(index)));
		node.parentNode.replaceChild(fragment, node);
	}
	return marks;
}

// Scroll a mark to the vertical center of the transcript container only.
// Deliberately not `scrollIntoView` (which also scrolls outer ancestors and
// can be undone by competing scrollers). Returns whether it scrolled.
export function scrollMarkIntoView(scopeEl, mark) {
  if (!scopeEl || !mark || typeof scopeEl.contains !== "function" || !scopeEl.contains(mark)) return false;
  try {
    const scopeRect = scopeEl.getBoundingClientRect();
    const markRect = mark.getBoundingClientRect();
    if (!markRect || (markRect.width === 0 && markRect.height === 0)) return false;
    const targetTop =
      scopeEl.scrollTop +
      (markRect.top - scopeRect.top) -
      scopeEl.clientHeight / 2 +
      markRect.height / 2;
    scopeEl.scrollTo({ top: targetTop, behavior: "auto" });
    return true;
  } catch {
    return false;
  }
}

// Toggle the active (current-match) styling across a live mark list.
export function setActiveFindMark(marks, activeIndex) {
	const list = Array.isArray(marks) ? marks : [];
	for (let i = 0; i < list.length; i++) {
		try {
			list[i].setAttribute("data-active", i === activeIndex ? "true" : "false");
		} catch {
			/* A streaming re-render may detach marks mid-navigation. */
		}
	}
}

// Index within `marks` of the nth occurrence of a query inside one message row.
// Canonical search yields { messageId, occurrence }; the rendered row supplies
// the actual marks, so navigation can highlight the exact segment a match
// refers to without depending on the rendered slice's order. Returns -1 when
// the row is not mounted (or the segment is not rendered, e.g. collapsed text).
export function markIndexForMessage(scopeEl, marks, messageId, occurrence = 0) {
	if (!scopeEl || !Array.isArray(marks) || messageId == null) return -1;
	let row;
	try {
		row = scopeEl.querySelector(`[data-message-id="${CSS.escape(String(messageId))}"]`);
	} catch {
		return -1;
	}
	if (!row) return -1;
	let seen = 0;
	for (let index = 0; index < marks.length; index++) {
		if (!row.contains(marks[index])) continue;
		if (seen === occurrence) return index;
		seen += 1;
	}
	return -1;
}
