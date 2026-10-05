'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const MODES = ['read_only', 'workspace_write', 'ask_approval', 'full_access'];
const READ_TOOLS = new Set(['get_recent_chat_history', 'search_project_content', 'search_code', 'read_project_file', 'read_file', 'list_directory', 'take_screenshot', 'search_memory', 'get_single_web_page_content', 'extract_web_page_data', 'spawn_subagent', 'delegate_task', 'use_skill', 'propose_skill']);
const WRITE_TOOLS = new Set(['write_project_file', 'write_file', 'str_replace_editor', 'edit_file']);
function resolveMode(mode, project) {
  const value = mode ?? project?.permissionMode ?? project?.permission_mode ?? (project ? 'workspace_write' : 'ask_approval');
  if (!MODES.includes(value)) throw new Error('Invalid permission mode.');
  return value;
}
function sessionProject(sessionId) {
  if (!sessionId) return null;
  return require('./db').db.prepare('SELECT p.* FROM projects p JOIN sessions s ON s.project_id = p.id WHERE s.id = ?').get(sessionId) ?? null;
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function workspacePath(root, value) {
  if (!root) throw new Error('Workspace Write requires a project root.');
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid file path.');
  root = await fs.realpath(root);
  const target = path.resolve(root, value);
  if (!inside(root, target)) throw new Error('Execution blocked: Path escapes the project root.');
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { await fs.lstat(current); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    if (!inside(root, await fs.realpath(current))) throw new Error('Execution blocked: Symlink escapes the project root.');
  }
  return target;
}
async function guardTool({ name, args = {}, permissionMode, project, requestApproval, signal, native = true }) {
  const mode = resolveMode(permissionMode, project);
  signal?.throwIfAborted();
  if (mode === 'full_access') return;
  const root = project?.rootDirectory ?? project?.root_path;
  const read = native && READ_TOOLS.has(name);
  if (mode === 'read_only') {
    if (!read) throw new Error('Execution blocked: Chat is in Read Only mode.');
    return;
  }
  if (mode === 'workspace_write') {
    if (native && name === 'generate_image') {
      if (!requestApproval || !await requestApproval({ name, args })) throw new Error('Execution blocked: Image generation approval denied.');
      signal?.throwIfAborted();
      return;
    }
    if (native && name === 'take_screenshot') {
      // The capture is read-only, but its optional saved artifact must stay in
      // the same project directory used by the screenshot executor.
      await workspacePath(root, '.llm_workspace/screenshots');
      return;
    }
    if (read) return;
    if (native && WRITE_TOOLS.has(name)) {
      await workspacePath(root, args.relative_path ?? args.path ?? args.file_path);
      return;
    }
    if (name === 'execute_command' && /\bsudo\b|\bapt(?:-get)?\s+install\b|\b(?:npm|pip\d*)\s+install\b[^\n]*(?:-g\b|--global\b)/i.test(args.command ?? '')) {
      throw new Error('Execution blocked: Global installations are not allowed in Workspace Write mode.');
    }
    if (native && name === 'execute_command') {
      if (typeof args.command !== 'string' || !args.command.trim() || args.command.includes('\0'))
        throw new Error('Invalid command.');
      const cwd = await workspacePath(root, args.cwd ?? '.');
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Execution blocked: Command cwd must be a directory.');
      return; // The native executor confines all shell writes, including git hooks, with bwrap.
    }
    // An unrestricted shell or third-party server can escape cwd. Fail closed until
    // an OS-level sandbox is available; never treat command string filtering as isolation.
    throw new Error('Execution blocked: This tool cannot be confined to the project workspace. Select Ask for Approval or Full Access.');
  }
  if (!read && !(native && WRITE_TOOLS.has(name))) {
    if (!requestApproval || !await requestApproval({ name, args })) throw new Error('Execution blocked: Tool approval denied.');
    signal?.throwIfAborted();
  }
}
function requestToolApproval({ controller, sender, requestId, sessionId, name, args }) {
  return new Promise(resolve => {
    const approvalId = require('node:crypto').randomUUID();
    const finish = allowed => {
      if (!controller.toolApprovals?.delete(approvalId)) return;
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', stop);
      if (!sender.isDestroyed()) sender.send('engine:request-tool-approval', { requestId, sessionId, approvalId, resolved: true });
      resolve(allowed);
    };
    const stop = () => finish(false);
    const timer = setTimeout(stop, 120000);
    controller.toolApprovals ??= new Map();
    controller.toolApprovals.set(approvalId, finish);
    controller.signal.addEventListener('abort', stop, { once: true });
    if (controller.signal.aborted || sender.isDestroyed()) return stop();
    sender.send('engine:request-tool-approval', { requestId, sessionId, approvalId, name, args });
  });
}
module.exports = { resolveMode, sessionProject, workspacePath, guardTool, requestToolApproval };
