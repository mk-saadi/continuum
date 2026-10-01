'use strict';

const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { db } = require('./db');

function text(value, field, { nullable = false, empty = false } = {}) {
  if (nullable && value == null) return null;
  if (typeof value !== 'string' || value.includes('\0') || (!empty && !value.trim())) {
    throw new TypeError(`Invalid project ${field}.`);
  }
  return value;
}

function inputObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Invalid project input.');
}

function projectFields(input) {
  inputObject(input);
  return {
    permission_mode: require('./toolPermissions').resolveMode(input.permissionMode ?? input.permission_mode, {}),
    name: text(input.name, 'name').trim(),
    description: text(input.description, 'description', { nullable: true, empty: true }),
    custom_instructions: text(input.custom_instructions, 'custom_instructions', { nullable: true, empty: true }),
    root_path: input.root_path == null || input.root_path === '' ? null : path.resolve(text(input.root_path, 'root_path')),
  };
}

function getProjectFiles(projectId) {
  text(projectId, 'ID');
  return db.prepare('SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at, id').all(projectId);
}

function getProject(id) {
  text(id, 'ID');
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  if (!project) throw new Error('Project not found.');
  return { ...project, files: getProjectFiles(id) };
}

function listProjects() {
  return db.prepare('SELECT * FROM projects ORDER BY is_pinned DESC, updated_at DESC, name, id').all();
}

function createProject(input) {
  const fields = projectFields(input);
  const id = randomUUID();
  db.prepare('INSERT INTO projects(id, name, description, custom_instructions, root_path, permission_mode) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, fields.name, fields.description, fields.custom_instructions, fields.root_path, fields.permission_mode);
  return getProject(id);
}

function updateProject(id, input) {
  inputObject(input);
  return db.transaction(() => {
    const fields = projectFields({ ...getProject(id), ...input });
    db.prepare(`UPDATE projects SET name = ?, description = ?, custom_instructions = ?, root_path = ?, permission_mode = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(fields.name, fields.description, fields.custom_instructions, fields.root_path, fields.permission_mode, id);
    return getProject(id);
  }).immediate();
}

function deleteProject(id) {
  text(id, 'ID');
  // Foreign keys remove context files and detach (preserve) existing chats.
  if (!db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) throw new Error('Project not found.');
  return { deleted: true };
}

function addProjectFile(projectId, input) {
  inputObject(input);
  const filePath = text(input.file_path, 'file_path');
  const fileName = text(input.file_name ?? path.basename(filePath), 'file_name');
  const content = text(input.content, 'file content', { empty: true });
  return db.transaction(() => {
    getProject(projectId);
    const id = randomUUID();
    db.prepare('INSERT INTO project_files(id, project_id, file_path, file_name, content) VALUES (?, ?, ?, ?, ?)')
      .run(id, projectId, filePath, fileName, content);
    db.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(projectId);
    return db.prepare('SELECT * FROM project_files WHERE id = ?').get(id);
  }).immediate();
}

function removeProjectFile(id) {
  text(id, 'file ID');
  return db.transaction(() => {
    const file = db.prepare('SELECT project_id FROM project_files WHERE id = ?').get(id);
    if (!file) throw new Error('Project file not found.');
    db.prepare('DELETE FROM project_files WHERE id = ?').run(id);
    db.prepare('UPDATE projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(file.project_id);
    return { deleted: true };
  }).immediate();
}

function setProjectPinned(id, isPinned) {
  text(id, 'ID');
  if (![true, false, 0, 1].includes(isPinned)) throw new TypeError('Invalid project is_pinned.');
  if (!db.prepare('UPDATE projects SET is_pinned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(Number(isPinned), id).changes) throw new Error('Project not found.');
  return getProject(id);
}

module.exports = { createProject, updateProject, deleteProject, listProjects, getProject, getProjectFiles,
  addProjectFile, removeProjectFile, setProjectPinned };

/** Read selected documents once and store a text snapshot for every project chat. */
async function importProjectFiles(projectId, filePaths) {
  getProject(projectId);
  if (!Array.isArray(filePaths) || !filePaths.length || filePaths.length > 10) throw new Error('Choose 1–10 context files at a time.');
  const { inspectFile } = require('./fileUploads');
  const files = filePaths.map(inspectFile);
  if (files.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) throw new Error('Context files must total 50 MB or less.');
  if (files.some(file => file.mime_type.startsWith('image/'))) throw new Error('Choose text documents or PDFs for project context.');
  const parsed = [];
  for (const file of files) {
    const bytes = await require('node:fs/promises').readFile(file.file_path);
    const content = await require('./ragManager').parseDocument(file.file_path, bytes);
    if (content.includes('\0')) throw new Error('Binary files cannot be used as project context.');
    if (!content.trim()) throw new Error(`${path.basename(file.file_path)} contains no readable text.`);
    parsed.push({ ...file, file_name: path.basename(file.file_path), content });
  }
  return db.transaction(() => parsed.map(file => addProjectFile(projectId, file))).immediate();
}
module.exports.importProjectFiles = importProjectFiles;
