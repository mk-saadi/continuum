// Classify a markdown link destination the way the chat transcript renders it.
// The transcript has no routes, so a destination that is not an absolute
// filesystem path and carries no URL scheme is a file reference relative to
// the chat's own base directory — never a web URL.
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function classifyChatHref(href) {
	if (typeof href !== 'string' || href === '') return 'external';
	// Protocol-relative URLs (//host/share) are web targets, not filesystem paths.
	if (href.startsWith('//')) return 'web-or-external';
	// In-page anchors stay in the page.
	if (href.startsWith('#')) return 'anchor';
	// Absolute POSIX paths open directly. The original handler required a
	// non-space second character, so a bare "/" stays on the external branch.
	if (href.startsWith('/')) return (href.length > 1 && !/\s/.test(href[1])) ? 'local-absolute' : 'external';
	if (SCHEME.test(href)) {
		return /^(https?):/i.test(href) ? 'web' : 'external';
	}
	// A relative destination: resolve it against the session's base directory
	// in the main process, which owns project roots and the agent's cwd.
	return 'local-relative';
}

export function isRelativeFileHref(href) {
	return classifyChatHref(href) === 'local-relative';
}
