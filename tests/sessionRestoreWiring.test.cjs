'use strict';
// Regression: tabs must only be flagged `saved` once their session row exists.
//
// `saved: true` is what makes ChatInterface rehydrate a tab's transcript on the
// next launch. A tab pointed at a freshly minted session id (New chat, or the
// replacement chat after deleting the active session) has no row yet, so
// keeping the previous `saved` value made startup call session:load-display
// for a missing id -- the "Session not found." handler errors this test guards
// against. The send path used to flag the tab before creating the row, which
// could produce the same state when a turn failed early.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const chatSource = fs.readFileSync(
	path.join(__dirname, '..', 'src', 'components', 'main-app', 'ChatInterface.jsx'),
	'utf8',
);
const ipcSource = fs.readFileSync(
	path.join(__dirname, '..', 'src', 'main', 'ipcHandlers.js'),
	'utf8',
);

const between = (source, startToken, endToken) => {
	const start = source.indexOf(startToken);
	assert.ok(start >= 0, `missing source marker: ${startToken}`);
	const end = source.indexOf(endToken, start);
	assert.ok(end > start, `missing end marker after ${startToken}: ${endToken}`);
	return source.slice(start, end);
};

test('New chat resets the saved flag for the freshly minted session', () => {
	const newChat = between(chatSource, 'const newChat = () =>', 'const newWorkspaceChat');
	assert.match(newChat, /saved: false/, 'newChat must mark the tab unsaved');
});

test('deleting the active session resets the saved flag before rebinding', () => {
	const block = between(
		chatSource,
		'await palace.api.deleteSession(id);',
		'await refreshHistory();',
	);
	assert.match(block, /saved: false/, 'replacement session has no row yet');
});

test('the send path flags the tab saved only after the row is created', () => {
	const create = chatSource.indexOf(
		'await palace.api.getOrCreateSession(palace.sessionId, selectedModel, chatProjectId)',
	);
	assert.ok(create >= 0, 'send path creates the session row');
	const mark = chatSource.indexOf('onTabSaved?.(palace.sessionId)', create);
	assert.ok(mark > create, 'onTabSaved must run after getOrCreateSession resolves');
});

test('loading an existing chat and creating a workspace chat mark the tab saved', () => {
	const loadChat = between(chatSource, 'const loadChat = async', 'const startProjectChat');
	assert.match(loadChat, /onTabSaved\?\.\(id\)/, 'sidebar load binds a live session');
	const workspace = between(chatSource, 'const newWorkspaceChat = async', 'const loadChat = async');
	assert.match(workspace, /onTabSaved\?\.\(id\)/, 'workspace creation binds a live session');
});

test('a missing display session is reported as null instead of a handler error', () => {
	const handler = between(ipcSource, '"session:load-display"', '"session:rename"');
	assert.match(
		handler,
		/if \(error\?\.message === 'Session not found\.'\) return null;/,
		'deleted/deferred sessions must not log a main-process error',
	);
	assert.match(chatSource, /setMessages\(session \? displayMessages\(session\) : \[\]\)/,
		'a null restore renders an empty chat');
});

console.log('Session restore wiring: saved flags follow row creation and missing sessions stay quiet.');
