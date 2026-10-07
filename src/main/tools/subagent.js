'use strict';

const spawnSubagentTool = {
  type: 'function',
  function: {
    name: 'spawn_sub_agent',
    description: `DELEGATED WORKER. Use for isolated web research on one public URL, OR to analyze a single local file and report back, OR pass investigate=true for an autonomous read-only investigation of the project. Returns a concise answer from the fetched page, file contents, or its own investigation.`,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Clear, specific question or instruction for the worker.' },
        constraint: { type: 'string', description: 'Optional length and omission rules, such as no raw HTML or boilerplate.' },
        expected_output: { type: 'string', description: 'Requested summary format, such as a markdown table and two sentences.' },
        url: { type: 'string', description: 'Public HTTP or HTTPS URL for web research (one per call).' },
        target_file: { type: 'string', description: 'Absolute path to a single local file to analyze.' },
        investigate: { type: 'boolean', description: 'Set true to let the worker investigate autonomously: it searches, reads, and lists project files (and may fetch public web pages) across several turns before returning one concise answer. Cannot be combined with url or target_file.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
};

// Parent-context protection, reviewed in Step 7 and kept on purpose: whatever a
// child returns lands in the parent's conversation as one tool result, so the
// parent context pays for every character — the result is bounded to a short
// summary (~1,800 characters). The full answer is NOT discarded: the child
// session keeps it (session.result plus the whole session.context), so the
// complete findings stay available internally for continuation (sendMessage /
// resume) and for inspection through the runtime. One helper, one limit, one
// notice — instead of the same slice repeated per path.
const PARENT_RESULT_LIMIT = 1800;
const TRUNCATED_NOTICE = '[Summary truncated]';
function boundResultForParent(answer) {
  if (typeof answer !== 'string' || answer.length <= PARENT_RESULT_LIMIT) return answer;
  return `${answer.slice(0, PARENT_RESULT_LIMIT - TRUNCATED_NOTICE.length - 1)}\n${TRUNCATED_NOTICE}`;
}

async function executeSpawnSubagent({ task, constraint = '', expected_output = '', url, target_file, investigate,
  engine, signal, parentSessionId = null, rootPath }) {
  if (typeof task !== 'string' || !task.trim() || task.length > 2000 || task.includes('\0')) {
    throw new Error('Task must be a non-empty instruction of at most 2,000 characters.');
  }
  for (const [name, value] of Object.entries({ constraint, expected_output })) {
    if (typeof value !== 'string' || value.length > 1000 || value.includes('\0')) {
      throw new Error(`${name} must be a string of at most 1,000 characters.`);
    }
  }
  if (investigate !== undefined && typeof investigate !== 'boolean') {
    throw new Error('investigate must be a boolean.');
  }

  // --- Autonomous investigation path ---
  // The read-only child agent loop: one foreground child session that
  // searches/reads its way to an answer over multiple model turns. The
  // specialized file-analysis and web-extraction paths below stay exactly as
  // they are — existing callers keep their behavior.
  if (investigate === true) {
    if (url !== undefined || target_file !== undefined) {
      throw new Error('Choose either investigate or url/target_file, not both.');
    }
    const instruction = [task, expected_output && `Expected output: ${expected_output}`,
      constraint && `Constraint: ${constraint}`].filter(Boolean).join('\n');
    const runtime = require('../subagents');
    const answer = await runtime.runInvestigation({ task: instruction, rootPath, engine, signal, parentSessionId });
    return boundResultForParent(answer);
  }

  // --- File analysis path ---
  if (target_file !== undefined) {
    if (typeof target_file !== 'string' || !target_file.trim()) {
      throw new Error('target_file must be a non-empty absolute path.');
    }
    const instruction = [task, expected_output && `Expected output: ${expected_output}`,
      constraint && `Constraint: ${constraint}`].filter(Boolean).join('\n');
    const runtime = require('../subagents');
    const summary = await runtime.runFileAnalysis({
      task_description: instruction,
      target_files: [target_file],
      rootPath: process.cwd(),
      engine, signal, parentSessionId,
    });
    return boundResultForParent(summary);
  }

  // --- Web URL path ---
  const mentionedUrls = [...new Set((task.match(/https?:\/\/[^\s\])}>"]+/gi) || [])
    .map(found => found.replace(/[.,;!?]+$/, '')))];
  if (url !== undefined && (typeof url !== 'string' || !url.trim())) throw new Error('url must be a web address.');
  const resolvedUrl = url ?? mentionedUrls[0];

  // Require exactly one URL for web research
  if (mentionedUrls.length > 1 || resolvedUrl && mentionedUrls.some(mentioned => mentioned !== resolvedUrl)) {
    throw new Error('Delegate one web URL per sub-agent call.');
  }
  const sourceUrl = resolvedUrl;
  if (!sourceUrl) throw new Error('Provide a url or target_file parameter.');

  const instruction = [task, expected_output && `Expected output: ${expected_output}`,
    constraint && `Constraint: ${constraint}`, 'Return only a concise answer. Do not include raw source content.']
    .filter(Boolean).join('\n');
  const runtime = require('../subagents');
  const summary = await runtime.runWebExtraction({ url: sourceUrl, query: instruction, engine, signal, parentSessionId });
  return boundResultForParent(summary);
}

module.exports = { spawnSubagentTool, executeSpawnSubagent, PARENT_RESULT_LIMIT };
