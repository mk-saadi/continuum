'use strict';

const { prependBaseSystemPrompt } = require('./baseSystemPrompt');
const fs = require('node:fs');
const { validateAttachments, attachmentName } = require('./fileUploads');
const { db } = require('./db');
const { getSessionAgent } = require('./agentManager');
const { getCoreMemories } = require('./memoryManager');
const { nativeTools } = require('./nativeTools');
const {
  getOrCreateSession, saveMessage, getActiveMessages, getSessionSummary, loadSession, getRegenerationTarget,
} = require('./sessionManager');

const memoryTools = [
  ...nativeTools.map(({ function: { name, description, parameters } }) => ({ name, description, input_schema: parameters })),
  {
    name: 'save_memory',
    description: 'Extract and save a concise, atomic fact, preference, or rule ABOUT THE USER to long-term memory. DO NOT save raw conversational strings, banter, or any facts/corrections regarding the AI model\'s identity or architecture.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: "Category: 'preference', 'tech_stack', 'project_rule', 'user_fact'. user_fact: Facts strictly about the user (e.g. location, role, background). NEVER use for AI model facts." },
        content: { type: 'string', description: "The distilled, normalized fact. Examples: 'Favorite color: black', 'Prefers package manager: pnpm', 'OS: macOS'. NEVER include conversational phrases like 'remember that' or 'from now on'." },
        always_inject: { type: 'boolean', default: true },
      },
      required: ['category', 'content'],
      additionalProperties: false,
    },
  },
];

function buildSystemPrompt({ modelId, memoryEnabled = true }) {
  if (typeof modelId !== 'string' || !modelId.trim() || modelId.includes('\0')) {
    throw new TypeError('modelId must be a non-empty string without null characters.');
  }
  if (typeof memoryEnabled !== 'boolean') throw new TypeError('memoryEnabled must be a boolean.');
  let coreMemoriesText = '';
  if (memoryEnabled) {
    coreMemoriesText = getCoreMemories(modelId)
      .map(({ category, content }) => `- [${category}]: ${content}`).join('\n');
  }

  return {
    role: 'system',
    content: `[BACKGROUND KNOWLEDGE & USER PREFERENCES]
${coreMemoriesText || (memoryEnabled ? 'No background memories saved yet.' : 'Automatic background memory injection is disabled.')}

`,
  };
}

function prepareChatMessages({ sessionId, modelId, userText, memoryEnabled = true, regenerate = false, attachments = [], regenerateLast = false }) {
  if (typeof regenerate !== 'boolean') throw new TypeError('Invalid regenerate flag.');
  if (!Array.isArray(attachments)) throw new TypeError('attachments must be an array.');
  if (typeof userText !== 'string' || (!userText.trim() && !attachments.length && !regenerate) || userText.includes('\0')) {
    throw new TypeError('Provide a message or an attachment; text cannot contain null characters.');
  }
  if (typeof memoryEnabled !== 'boolean') {
    throw new TypeError('memoryEnabled must be a boolean.');
  }

  // Prompt construction and history reads use one consistent snapshot.
  return db.transaction(() => {
    getOrCreateSession(sessionId, modelId);

    if (regenerateLast) getRegenerationTarget(sessionId);
    else if (!regenerate) saveMessage(sessionId, 'user', userText, attachments);
    else if (getActiveMessages(sessionId).at(-1)?.role !== 'user') throw new Error('No user message to regenerate.');
    const systemPrompt = buildSystemPrompt({ modelId, memoryEnabled });
    const agent = getSessionAgent(sessionId);
    const effective = require('./profileSettings').getSessionSettings(sessionId, modelId).effective;
    if (effective.systemPrompt) systemPrompt.content += `\n\n[${agent ? `ACTIVE AGENT: ${agent.name}` : 'ASSISTANT INSTRUCTIONS'}]\n${effective.systemPrompt}`;
    const summary = regenerateLast ? null : getSessionSummary(sessionId);
    const activeSessionMessages = (regenerateLast ? loadSession(sessionId).messages.slice(0, -1) : getActiveMessages(sessionId))
      .map(messageForModel);

    return prependBaseSystemPrompt([
      systemPrompt,
      ...(summary ? [{ role: 'system', content: `Earlier conversation summary:\n${summary}` }] : []),
      ...activeSessionMessages,
    ]);
  }).immediate();
}

function messageForModel({ role, content, attachments = [] }) {
  if (role !== 'user' || !attachments.length) return { role, content };
  const files = validateAttachments(attachments);
  const attachmentContext = [];
  const images = [];
  for (const { file_path, mime_type } of files) {
    const header = `[Attached File: ${attachmentName(file_path)}]`;
    const isText = mime_type.startsWith('text/') || mime_type === 'application/json';
    if (isText && fs.statSync(file_path).size < 50 * 1024) {
      const raw = fs.readFileSync(file_path, 'utf-8');
      // Use a longer fence if the attached document contains Markdown fences.
      const fence = '`'.repeat(Math.max(3, ...Array.from(raw.matchAll(/`+/g), match => match[0].length + 1)));
      attachmentContext.push(`${header}\n${fence}\n${raw}\n${fence}\n[End of Attached File]`);
    } else {
      attachmentContext.push(`${header}\nAbsolute path: ${file_path}\n[End of Attached File]`);
    }
    if (mime_type.startsWith('image/')) {
      images.push({ type: 'image_url', image_url: { url: `data:${mime_type};base64,${fs.readFileSync(file_path, 'base64')}` } });
    }
  }
  const text = `${attachmentContext.join('\n\n')}\n\nUser Prompt: ${content}`;
  return { role, content: images.length ? [{ type: 'text', text }, ...images] : text };
}

function getToolContext(mcpTools = []) {
  const tools = [...memoryTools.map(({ name, description, input_schema }) => ({
    type: 'function', function: { name, description, parameters: input_schema },
  })), ...mcpTools];
  // Model tokenizers and chat templates differ; explicitly report an estimate.
  const estimate = value => value.length ? Math.ceil(JSON.stringify(value).length / 4) : 0;
  return { tools, pluginTokens: estimate(mcpTools), toolTokens: estimate(tools), tokenCountMethod: 'characters/4' };
}

module.exports = { getToolContext, memoryTools, buildSystemPrompt, prepareChatMessages, messageForModel };
