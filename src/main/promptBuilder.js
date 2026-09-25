'use strict';

const fs = require('node:fs');
const { validateAttachments, attachmentName } = require('./fileUploads');
const { db } = require('./db');
const { getSessionAgent } = require('./agentManager');
const { getCoreMemories } = require('./memoryManager');
const { nativeTools } = require('./nativeTools');
const {
  getOrCreateSession, saveMessage, getActiveMessages, getSessionSummary,
} = require('./sessionManager');

const memoryTools = [
  ...nativeTools.map(({ function: { name, description, parameters } }) => ({ name, description, input_schema: parameters })),
  {
    name: 'save_memory',
    description: 'Extract and save a concise, atomic fact, preference, or rule to long-term memory. DO NOT save raw user conversational strings.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: "Category: 'preference', 'tech_stack', 'project_rule', 'user_fact'" },
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
    content: `You are an AI desktop assistant equipped with persistent Memory Palace storage via native tools.

[BACKGROUND KNOWLEDGE & USER PREFERENCES]
${coreMemoriesText || (memoryEnabled ? 'No background memories saved yet.' : 'Automatic background memory injection is disabled.')}

MEMORY & CONVERSATION RULES:
1. PASSIVE KNOWLEDGE RULE: Treat Background Knowledge strictly as PASSIVE KNOWLEDGE. Do NOT bring it up, list it, or mention it unless the user explicitly asks or it is directly relevant.
2. CASUAL GREETINGS: If the user says a simple greeting ("hey", "hello", "hi"), respond with a brief, natural greeting. NEVER announce what you remember about them upon greeting.
3. WHEN TO SEARCH MEMORY: For ANY recall task involving permanent facts, preferences, past project details, or previous conversations, call the \`search_memory\` tool before answering.
4. WHEN TO SAVE MEMORY: If the user tells you to remember a fact/preference ("remember that...", "my favorite X is Y", "always use Z"), call the \`save_memory\` tool immediately. Distill one short, atomic fact per call; never save the raw conversational sentence. For example, "Remember that I prefer TypeScript over JavaScript for all new files." becomes "Prefers TypeScript over JavaScript". Split independent facts into separate calls, preserving negations and meaningful project constraints.
5. NATURAL TONE: Speak naturally. Never use meta-phrases like "According to my memory palace...", "I have called save_memory...", or "In my database...".
`,
  };
}

function prepareChatMessages({ sessionId, modelId, userText, memoryEnabled = true, regenerate = false, attachments = [] }) {
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

    if (!regenerate) saveMessage(sessionId, 'user', userText, attachments);
    else if (getActiveMessages(sessionId).at(-1)?.role !== 'user') throw new Error('No user message to regenerate.');
    const systemPrompt = buildSystemPrompt({ modelId, memoryEnabled });
    const agent = getSessionAgent(sessionId);
    if (agent) systemPrompt.content += `\n\n[ACTIVE AGENT: ${agent.name}]\n${agent.system_prompt}`;
    const summary = getSessionSummary(sessionId);
    const activeSessionMessages = getActiveMessages(sessionId)
      .map(messageForModel);

    return [
      systemPrompt,
      ...(summary ? [{ role: 'system', content: `Earlier conversation summary:\n${summary}` }] : []),
      ...activeSessionMessages,
    ];
  }).immediate();
}

function messageForModel({ role, content, attachments = [] }) {
  if (role !== 'user' || !attachments.length) return { role, content };
  const files = validateAttachments(attachments);
  let text = content;
  const images = [];
  for (const { file_path, mime_type } of files) {
    if (mime_type.startsWith('image/')) {
      images.push({ type: 'image_url', image_url: { url: `data:${mime_type};base64,${fs.readFileSync(file_path, 'base64')}` } });
    } else {
      text += `\n[Attached document for retrieval: ${attachmentName(file_path)}]`;
    }
  }
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
