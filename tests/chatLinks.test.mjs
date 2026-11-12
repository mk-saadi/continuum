import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyChatHref, isRelativeFileHref } from '../src/lib/chatLinks.mjs';

// Chat markdown has no routes: a destination with no scheme is a file
// reference relative to the chat's base directory, not a web URL. Getting
// this wrong is what made `[x](src/lib/thing.mjs)` render as a target="_blank"
// link that Electron silently refused to open.
test('relative file references are classified for main-process resolution', () => {
	assert.equal(classifyChatHref('src/lib/remarkLocalPaths.mjs'), 'local-relative');
	assert.equal(classifyChatHref('./notes/todo.md'), 'local-relative');
	assert.equal(classifyChatHref('README.md'), 'local-relative');
	assert.ok(isRelativeFileHref('src/lib/remarkLocalPaths.mjs'));
});

test('absolute paths keep the direct shell.openPath route', () => {
	assert.equal(classifyChatHref('/home/user/thing.mjs'), 'local-absolute');
	assert.equal(classifyChatHref('/tmp/file.txt'), 'local-absolute');
	// The original handler required a non-space second character.
	assert.equal(classifyChatHref('/'), 'external');
	assert.equal(classifyChatHref('/ x'), 'external');
});

test('web URLs keep the LinkPopover route', () => {
	assert.equal(classifyChatHref('https://example.com/docs'), 'web');
	assert.equal(classifyChatHref('http://example.com'), 'web');
	assert.equal(classifyChatHref('HTTPS://example.com'), 'web');
});

test('scheme-bearing destinations are never treated as local files', () => {
	assert.equal(classifyChatHref('mailto:someone@example.com'), 'external');
	assert.equal(classifyChatHref('vscode://file/tmp/x'), 'external');
	assert.equal(classifyChatHref('file:///tmp/x.txt'), 'external');
	assert.equal(classifyChatHref('ircs://chat.example'), 'external');
});

test('protocol-relative and in-page destinations stay out of the local routes', () => {
	assert.equal(classifyChatHref('//host/share/x'), 'web-or-external');
	assert.equal(classifyChatHref('#section'), 'anchor');
});

test('missing or non-string hrefs fall back to the generic anchor', () => {
	assert.equal(classifyChatHref(null), 'external');
	assert.equal(classifyChatHref(undefined), 'external');
	assert.equal(classifyChatHref(''), 'external');
	assert.equal(isRelativeFileHref(null), false);
});
