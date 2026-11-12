// Make bare absolute filesystem paths clickable, without breaking markdown.
//
// Agents often render a raw path as prose:
//   /home/user/collection/dismembered/[Faltain]_Living_Skinsuit___
// Such a run cannot be linkified from the mdast alone: markdown itself consumes
// `[Faltain]` as a link reference and `_Living_Skinsuit___` as emphasis, so the
// path arrives as several sibling nodes and is already visually corrupted.
//
// The fix runs in two stages:
//   1. protectLocalPaths() rewrites each bare path in the *source* to an opaque
//      marker and remembers the original string. Markdown then has nothing to
//      interpret, so the path survives intact as plain text.
//   2. remarkLocalPaths() swaps each marker back out for a real `link` node.
// Emitting a real link keeps the renderer contract: the `a` component in
// ChatMessage.jsx already routes absolute hrefs to window.api.openPath.
//
// Code spans, fenced blocks, inline HTML attributes and existing link/image
// destinations are left alone so author-formatted content is never rewritten.

const MARKER_OPEN = '\uE000';
const MARKER_CLOSE = '\uE001';
const MARKER_RE = /\uE000(\d+)\uE001/g;

// A path must not contain whitespace, quotes, angle brackets, pipes or
// backticks, and `*` is excluded so trailing emphasis cannot be swallowed.
const PATH_BODY = /^\/[^\s'"`<>|*\\]*/;
// A path is only worth linking with at least two segments (/tmp/x, not /tmp).
const MIN_SEGMENTS = 2;
// Characters that may legally precede a path in prose.
const LEADING_BOUNDARY = /[\s([{>"'`—–]/;

function count(value, char) {
	let total = 0;
	for (const c of value) if (c === char) total += 1;
	return total;
}

// Sentence punctuation and unbalanced closers belong to the sentence, not the
// path, so they are handed back to the surrounding text.
function trimTrailing(value) {
	let trimmed = value.replace(/[.,;:!?]+$/, '');
	for (;;) {
		const last = trimmed[trimmed.length - 1];
		const pairs = { ')': '(', ']': '[', '}': '{' };
		if (pairs[last] && count(trimmed, pairs[last]) < count(trimmed, last)) {
			trimmed = trimmed.slice(0, -1);
			continue;
		}
		break;
	}
	return trimmed;
}

function isLinkablePath(candidate) {
	if (!candidate.startsWith('/') || candidate.startsWith('//')) return false;
	return candidate.split('/').filter(Boolean).length >= MIN_SEGMENTS;
}

// Skip fenced blocks and inline code so `path` examples stay literal.
function skipCode(source, index) {
	const char = source[index];
	if (char !== '`' && char !== '~') return null;
	const fence = source.slice(index).match(char === '`' ? /^`{3,}/ : /^~{3,}/);
	if (fence) {
		const end = source.indexOf(fence[0], index + fence[0].length);
		return end === -1 ? source.length : end + fence[0].length;
	}
	// Only a backtick run can open an inline code span. A lone or doubled `~`
	// is GFM strikethrough (or prose), so it must stay in the text: matching
	// backticks there finds nothing and used to dereference a null match.
	const run = source.slice(index).match(/^`+/)?.[0];
	if (!run) return null;
	const end = source.indexOf(run, index + run.length);
	return end === -1 ? null : end + run.length;
}

// Skip the parenthesised destination of an inline link or image: ]( ... ).
function skipLinkDestination(source, index) {
	if (source[index] !== ']' || source[index + 1] !== '(') return null;
	let depth = 1;
	let cursor = index + 2;
	while (cursor < source.length && depth > 0) {
		if (source[cursor] === '(') depth += 1;
		else if (source[cursor] === ')') depth -= 1;
		cursor += 1;
	}
	return cursor;
}

// Skip the quoted value of an inline href="..." or src="..." attribute.
function skipAttributeValue(source, index) {
	const quote = source[index];
	if (quote !== '"' && quote !== "'") return null;
	const before = source.slice(Math.max(0, index - 8), index);
	if (!/(?:href|src)\s*=\s*$/i.test(before)) return null;
	const end = source.indexOf(quote, index + 1);
	return end === -1 ? null : end + 1;
}

export function protectLocalPaths(source) {
	if (typeof source !== 'string' || !source.includes('/')) {
		return { text: typeof source === 'string' ? source : '', paths: [] };
	}
	try {
		return protectLocalPathsUnsafe(source);
	} catch {
		// Linkification is a convenience. If the scanner ever trips over an
		// unexpected shape, render the original text instead of letting the
		// throw escape into a render and unmount the whole app.
		return { text: source, paths: [] };
	}
}

function protectLocalPathsUnsafe(source) {
	const paths = [];
	const out = [];
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		const skipped =
			skipCode(source, index) ??
			skipLinkDestination(source, index) ??
			skipAttributeValue(source, index);
		if (skipped != null) {
			out.push(source.slice(index, skipped));
			index = skipped;
			continue;
		}
		const bounded = index === 0 || LEADING_BOUNDARY.test(source[index - 1]);
		if (char === '/' && bounded) {
			const match = source.slice(index).match(PATH_BODY);
			const candidate = match ? trimTrailing(match[0]) : '';
			if (isLinkablePath(candidate)) {
				out.push(`${MARKER_OPEN}${paths.length}${MARKER_CLOSE}`);
				paths.push(candidate);
				index += candidate.length;
				continue;
			}
		}
		out.push(char);
		index += 1;
	}
	return { text: out.join(''), paths };
}

// Replace marker runs inside one text node with text/link/text siblings.
function splitMarkers(value, paths) {
	MARKER_RE.lastIndex = 0;
	const nodes = [];
	let cursor = 0;
	let match;
	while ((match = MARKER_RE.exec(value)) !== null) {
		const target = paths[Number(match[1])];
		if (target == null) continue;
		if (match.index > cursor) nodes.push({ type: 'text', value: value.slice(cursor, match.index) });
		nodes.push({ type: 'link', url: target, children: [{ type: 'text', value: target }] });
		cursor = match.index + match[0].length;
	}
	if (nodes.length === 0) return null;
	if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) });
	return nodes;
}

// Never descend into nodes whose text must stay literal.
const SKIP_TYPES = new Set([
	'link',
	'linkReference',
	'image',
	'imageReference',
	'code',
	'inlineCode',
	'html',
	'definition',
	'yaml',
	'toml',
	'math',
]);

function walk(node, paths) {
	if (!Array.isArray(node.children) || SKIP_TYPES.has(node.type)) return;
	const next = [];
	for (const child of node.children) {
		if (child.type === 'text') {
			const replaced = splitMarkers(child.value, paths);
			if (replaced) next.push(...replaced);
			else next.push(child);
			continue;
		}
		walk(child, paths);
		next.push(child);
	}
	node.children = next;
}

export function remarkLocalPaths(options = {}) {
	const paths = Array.isArray(options.paths) ? options.paths : [];
	return tree => {
		if (paths.length > 0) walk(tree, paths);
	};
}
