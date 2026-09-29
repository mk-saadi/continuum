'use strict';

const fs = require('node:fs/promises');
const { localEngineFetch } = require('./localEngineFetch');
const { scopedPath } = require('./tools/agentTools');

const SUB_AGENT_SYSTEM_PROMPT = 'You are a specialized research sub-agent. Complete the assigned sub-task thoroughly and return ONLY a concise 2-3 paragraph summary of your findings or code location.';
const MAX_SUMMARY_TOKENS = 1024;
const MAX_SUMMARY_CHARACTERS = 6000;

/** One awaited completion on the existing server; no new process, model, tools, or history. */
async function runSubAgent({ task_description, target_files, rootPath, engine, signal, fetchImpl = localEngineFetch }) {
  if (typeof task_description !== 'string' || !task_description.trim() || task_description.includes('\0')) {
    throw new Error('task_description must be a non-empty string.');
  }
  if (!Array.isArray(target_files) || target_files.length > 32 ||
      target_files.some(file => typeof file !== 'string' || !file.trim() || file.includes('\0'))) {
    throw new Error('target_files must be an array of up to 32 project-relative file paths.');
  }
  if (!Number.isInteger(engine?.port) || engine.port < 1 || engine.port > 65535 ||
      typeof engine.modelId !== 'string' || !engine.modelId.trim()) {
    throw new Error('Start the local model server before delegating a task.');
  }
  signal?.throwIfAborted();
  const root = await fs.realpath(rootPath);
  const contextLength = engine.contextLength ?? 32768;
  if (!Number.isSafeInteger(contextLength) || contextLength < 2048) throw new Error('The loaded context is too small for delegation.');
  // UTF-8 bytes are a conservative token upper bound. Reject oversized tasks;
  // never silently omit requested raw file contents or change server allocation.
  const inputBudget = Math.min(512 * 1024, contextLength - MAX_SUMMARY_TOKENS - 512);
  let userText = task_description;
  let inputBytes = Buffer.byteLength(SUB_AGENT_SYSTEM_PROMPT) + Buffer.byteLength(userText);
  const checkBudget = () => {
    if (inputBytes > inputBudget) throw new Error('Delegated input exceeds the sub-agent context budget. Request fewer or smaller target files.');
  };
  checkBudget();
  for (const relativePath of target_files) {
    signal?.throwIfAborted();
    const filePath = await scopedPath(root, relativePath);
    const file = await fs.open(filePath, 'r');
    let bytes;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error(`Target is not a regular file: ${relativePath}`);
      inputBytes += stat.size;
      checkBudget();
      bytes = await file.readFile({ signal });
    } finally { await file.close(); }
    if (bytes.includes(0)) throw new Error(`Target is not a UTF-8 text file: ${relativePath}`);
    let content;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`Target is not a UTF-8 text file: ${relativePath}`); }
    userText += `\n\n[FILE: ${relativePath}]\n${content}\n[END FILE]`;
    inputBytes = Buffer.byteLength(SUB_AGENT_SYSTEM_PROMPT) + Buffer.byteLength(userText);
    checkBudget();
  }
  signal?.throwIfAborted();
  const response = await fetchImpl(`http://127.0.0.1:${engine.port}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({
      model: engine.modelId,
      messages: [{ role: 'system', content: SUB_AGENT_SYSTEM_PROMPT }, { role: 'user', content: userText }],
      stream: false, temperature: 0.2, max_tokens: MAX_SUMMARY_TOKENS,
      tools: [], tool_choice: 'none',
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Sub-agent request failed (HTTP ${response.status}).`);
  }
  const result = await response.json();
  signal?.throwIfAborted();
  const message = result.choices?.[0]?.message;
  if (message?.tool_calls?.length) throw new Error('Sub-agent attempted a tool call; delegation only returns a summary.');
  const summary = typeof message?.content === 'string' ? message.content.trim() : null;
  if (typeof summary !== 'string' || !summary) throw new Error('Sub-agent returned no summary. Try a smaller, more specific task.');
  // Only this bounded summary leaves the isolated request, never its input or reasoning.
  return summary.length > MAX_SUMMARY_CHARACTERS
    ? `${summary.slice(0, MAX_SUMMARY_CHARACTERS)}\n[Summary truncated]` : summary;
}

module.exports = { runSubAgent, SUB_AGENT_SYSTEM_PROMPT };
