'use strict';
// Trusted fixture user consent, never a model argument or production bypass.
module.exports = async function approvedNativeCommand(options) {
  const tools = require('../../src/main/tools/agentTools');
  if (!require('../../src/main/nativeExecutionPolicy').isProtected(options.name)) return tools.executeAgentTool(options);
  const policy = require('../../src/main/toolPermissions');
  try {
    const args = typeof options.arguments === 'string' ? JSON.parse(options.arguments) : options.arguments;
    const approval = await policy.guardTool({ name: options.name, args, sessionId: options.sessionId,
      permissionMode: options.permissionMode, project: policy.sessionProject(options.sessionId), signal: options.signal,
      requestApproval: () => true });
    return tools.executeAgentTool({ ...options, approval, permissionGranted: true });
  } catch (error) { return { success: false, error: error.message, code: error.code }; }
};
