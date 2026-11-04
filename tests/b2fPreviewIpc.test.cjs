'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandlers } = require('../src/main/previewIpc');
test('preview IPC derives context, enforces ownership and never returns browser handoffs', async () => {
  const ctx = {}, calls = []; let ready = true, valid = true;
  const handlers = createHandlers({ readiness: () => ({ available: ready }),
    contexts: { forTool(session, fallback) { assert.equal(session, 'owner'); assert.equal(fallback, 'read_only'); return ctx; } },
    projectFor: session => session === 'owner' ? { root_path: '/trusted' } : null,
    background: { previewAuthority(id, actor) { assert.equal(actor, ctx); if (id !== 'owned' || !valid) throw Error('denied'); return { validate() {} }; } },
    gateway: { create(actor, args) { assert.equal(actor, ctx); calls.push(args); return { status: 'ready', url: 'http://127.0.0.1:1234/' }; },
      status() { throw Object.assign(Error('missing'), { code: 'PREVIEW_NOT_FOUND' }); },
      open(actor, id) { assert.equal(actor, ctx); assert.equal(id, 'owned'); return 'SECRET'; }, close() {} } });
  const args = { sessionId: 'owner', commandId: 'owned', guestPort: 5173, workspace: '/evil', pid: 1 };
  assert.equal(handlers['session:preview-status'](args).status, 'not_created');
  await handlers['session:create-preview'](args);
  assert.deepEqual(calls, [{ background_command_id: 'owned', guest_port: 5173 }]);
  assert.deepEqual(await handlers['session:open-preview'](args), { opened: true });
  for (const channel of Object.keys(handlers)) {
    await assert.rejects(async () => handlers[channel]({ ...args, sessionId: 'other' }), /Workspace/);
    await assert.rejects(async () => handlers[channel]({ ...args, commandId: 'other' }), /denied/);
  }
  valid = false;
  await assert.rejects(async () => handlers['session:open-preview'](args), /denied/);
  ready = false;
  assert.deepEqual(handlers['session:preview-status'](args), { available: false, status: 'unavailable' });
  await assert.rejects(async () => handlers['session:create-preview'](args), /NOT_READY/);
});
