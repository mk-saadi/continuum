'use strict';

const spawnSubagentTool = {
  type: 'function',
  function: {
    name: 'spawn_sub_agent',
    description: `DELEGATED WORKER. Use for isolated web research on one public URL, OR to analyze a single local file and report back. Returns a concise answer from the fetched page or file contents.`,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Clear, specific question or instruction for the worker.' },
        constraint: { type: 'string', description: 'Optional length and omission rules, such as no raw HTML or boilerplate.' },
        expected_output: { type: 'string', description: 'Requested summary format, such as a markdown table and two sentences.' },
        url: { type: 'string', description: 'Public HTTP or HTTPS URL for web research (one per call).' },
        target_file: { type: 'string', description: 'Absolute path to a single local file to analyze.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
};

async function executeSpawnSubagent({ task, constraint = '', expected_output = '', url, target_file,
  engine, signal, parentSessionId = null }) {
  if (typeof task !== 'string' || !task.trim() || task.length > 2000 || task.includes('\0')) {
    throw new Error('Task must be a non-empty instruction of at most 2,000 characters.');
  }
  for (const [name, value] of Object.entries({ constraint, expected_output })) {
    if (typeof value !== 'string' || value.length > 1000 || value.includes('\0')) {
      throw new Error(`${name} must be a string of at most 1,000 characters.`);
    }
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
    return summary.length > 1800 ? `${summary.slice(0, 1780)}\n[Summary truncated]` : summary;
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
  return summary.length > 1800 ? `${summary.slice(0, 1780)}\n[Summary truncated]` : summary;
}

module.exports = { spawnSubagentTool, executeSpawnSubagent };
