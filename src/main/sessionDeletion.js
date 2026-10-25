'use strict';

// Serialize deletion while existing execution/authorization owners settle. The
// content-free SQL marker handles stale requests across application restarts.
const pending = new Map();
function assertAvailable(sessionId) {
  if (pending.has(sessionId) || require('./db').db.prepare('SELECT 1 FROM deleted_sessions WHERE id = ?').get(sessionId))
    throw new Error('Conversation was permanently deleted or is being deleted.');
}
function deleteConversation(sessionId, sender, ownsController) {
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.includes('\0')) throw new TypeError('Invalid sessionId.');
  const controller = require('./engineManager').activeStreams.get(sessionId);
  if (controller && !ownsController(controller)) throw new Error('This conversation is running in another session.');
  if (pending.has(sessionId)) return pending.get(sessionId);
  // Install the guard synchronously, before yielding to any cancellation work.
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  pending.set(sessionId, promise);
  void (async () => {
    require('./sessionManager').loadSession(sessionId); // Validate before revocation.
    require('./lspExecutionContext').forget(sessionId);
    controller?.abort(Object.assign(new Error('Conversation deletion requested.'), { code: 'deleted-conversation' }));
    await require('./compressionEngine').cancelSessionCompression(sessionId);
    await require('./subagents/continuationManager').forgetParent(sessionId);
    if (controller) {
      if (!controller.settled) throw new Error('Active run cleanup cannot be verified. Retry after it stops.');
      await controller.settled;
    }
    await require('./backgroundCommands').forgetSession(sessionId);
    const result = require('./sessionManager').deleteSession(sessionId);
    require('./promptMeasurement').invalidateMeasuredContext(sessionId);
    require('./mcpManager').forgetSession(sessionId);
    require('./nativeToolActivation').forgetSession(sessionId);
    // Mounted tabs and sidebars discard their references to the deleted ID.
    try { if (sender && !sender.isDestroyed()) sender.send('session:deleted', { sessionId }); }
    catch (error) { console.error('Conversation deleted; renderer notification failed:', error.message); }
    return result;
  })().then(resolve, reject).finally(() => pending.delete(sessionId));
  return promise;
}
module.exports = { assertAvailable, deleteConversation };
