'use strict';
// Called only by the existing trusted-sender/data-access IPC wrapper. The
// renderer supplies a session selector, never an execution identity or path.
function createHandlers({ gateway = require('./developmentPreviews').service,
  readiness = require('./workspaceNetworkPolicy').readiness,
  contexts = require('./lspExecutionContext'), background = require('./backgroundCommands'),
  projectFor = require('./toolPermissions').sessionProject } = {}) {
  function context(sessionId) {
    const project = projectFor(sessionId);
    if (!project?.root_path) throw new Error('Workspace session required.');
    // No renderer-selected mode and no revision mutation on inspection.
    return contexts.forTool(sessionId, 'read_only');
  }
  function authorize(sessionId, commandId) {
    if (!readiness().available) throw new Error('WORKSPACE_NETWORK_NOT_READY');
    const ctx = context(sessionId);
    background.previewAuthority(commandId, ctx).validate();
    return ctx;
  }
  return {
    'session:preview-status': ({ sessionId, commandId }) => {
      if (!readiness().available) return { available: false, status: 'unavailable' };
      const ctx = authorize(sessionId, commandId);
      try { return { available: true, ...gateway.status(ctx, commandId) }; }
      catch (error) { if (error.code === 'PREVIEW_NOT_FOUND') return { available: true, status: 'not_created' }; throw error; }
    },
    'session:create-preview': ({ sessionId, commandId, guestPort }) =>
      gateway.create(authorize(sessionId, commandId), { background_command_id: commandId, guest_port: guestPort }),
    'session:open-preview': async ({ sessionId, commandId }) => {
      await gateway.open(authorize(sessionId, commandId), commandId);
      return { opened: true }; // Never return the handoff URL.
    },
    'session:close-preview': ({ sessionId, commandId }) => {
      gateway.close(authorize(sessionId, commandId), commandId);
      return { closed: true };
    },
  };
}
module.exports = { createHandlers };
