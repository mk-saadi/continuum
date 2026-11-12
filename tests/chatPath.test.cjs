// Relative markdown links in chat resolve against the session's base directory
// in main: the project root for a Workspace session, the agent's cwd for a
// casual one. Without this the renderer has no idea what `src/lib/x.mjs` means.
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
const rows = new Map();
Module._load = function (name, ...args) {
	if (name === 'electron') return { app: { isReady: () => true, getPath: () => '/tmp' } };
	if (name === 'better-sqlite3') return class FixtureDb { close() {} };
	return originalLoad.call(this, name, ...args);
};

const { resolveChatPath, sessionBaseDirectory } = require('../src/main/chatPath.js');
Module._load = originalLoad;

// chatPath reads the session's project through db.js; swap in a fixture so the
// test runs without Electron or a real database file.
const dbPath = require.resolve('../src/main/db.js');
require.cache[dbPath] = {
	id: dbPath,
	filename: dbPath,
	loaded: true,
	exports: {
		isInitialized: () => true,
		db: {
			prepare: sql => ({
				get: (...params) =>
					/FROM sessions JOIN projects/.test(sql) ? (rows.get(params[0]) ?? null) : null,
				all: () => [],
			}),
		},
	},
};

const PROJECT_ROOT = path.resolve('/home/fixture/workspace');

// A session bound to a project resolves relative links inside that project.
rows.set('workspace-session', { root_path: PROJECT_ROOT });
assert.equal(sessionBaseDirectory('workspace-session'), PROJECT_ROOT);
assert.equal(
	resolveChatPath('src/lib/remarkLocalPaths.mjs', 'workspace-session'),
	path.join(PROJECT_ROOT, 'src/lib/remarkLocalPaths.mjs'),
);

// Traversal in the stored destination never reaches the shell.
assert.throws(() => resolveChatPath('/tmp/../etc/passwd', 'workspace-session'), /absolute local file path/);

// A casual session has no project: relative links resolve against the agent's
// own working directory, exactly like its shell commands do.
rows.set('casual-session', null);
assert.equal(sessionBaseDirectory('casual-session'), process.cwd());
assert.equal(resolveChatPath('notes/todo.md', 'casual-session'), path.join(process.cwd(), 'notes/todo.md'));
assert.equal(resolveChatPath('notes/todo.md', null), path.join(process.cwd(), 'notes/todo.md'));

// Absolute paths and file:// URLs are already complete and pass through.
assert.equal(resolveChatPath('/tmp/already/absolute.txt', null), path.resolve('/tmp/already/absolute.txt'));
assert.equal(resolveChatPath('file:///tmp/already/absolute.txt', null), path.resolve('/tmp/already/absolute.txt'));

// Malformed destinations never reach the shell.
assert.throws(() => resolveChatPath('', 'casual-session'), /file path/);
assert.throws(() => resolveChatPath('/tmp/a\0b', 'casual-session'), /file path/);
assert.throws(() => resolveChatPath(42, 'casual-session'), /file path/);
assert.throws(() => resolveChatPath('file://host/share/x.txt', 'casual-session'), /file path/);

// An unknown session falls back to the process cwd rather than throwing.
assert.equal(resolveChatPath('a/b.txt', 'missing-session'), path.join(process.cwd(), 'a/b.txt'));

delete require.cache[dbPath];
console.log('chatPath: ok');
