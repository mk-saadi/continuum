'use strict';

const spawnSubagentTool = {
  type: 'function',
  function: {
    name: 'spawn_subagent',
    description: 'Use an isolated, throwaway context to inspect one public web page or a small set of project files. Mandatory for full-page reading, each source in multi-source research, and files over 500 lines or raw logs. Returns only a concise summary; raw page/file content never enters the main chat context. Call once per web URL.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'One specific question or research task. Include the source URL for web research.' },
        constraint: { type: 'string', description: 'Optional length and omission rules, such as no raw HTML or boilerplate.' },
        expected_output: { type: 'string', description: 'Requested summary format, such as a markdown table and two sentences.' },
        url: { type: 'string', description: 'Optional explicit public HTTP or HTTPS URL; one URL per invocation.' },
        target_files: { type: 'array', items: { type: 'string' }, maxItems: 32,
          description: 'Project-relative files to inspect when the task is about files or logs.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
};

async function executeSpawnSubagent({ task, constraint = '', expected_output = '', url, target_files = [],
  rootPath, engine, signal }) {
  if (typeof task !== 'string' || !task.trim() || task.length > 2000 || task.includes('\0')) {
    throw new Error('Sub-agent task must be a non-empty instruction of at most 2,000 characters.');
  }
  for (const [name, value] of Object.entries({ constraint, expected_output })) {
    if (typeof value !== 'string' || value.length > 1000 || value.includes('\0')) {
      throw new Error(`${name} must be a string of at most 1,000 characters.`);
    }
  }
  if (!Array.isArray(target_files) || target_files.length > 32 || target_files.some(file => typeof file !== 'string')) {
    throw new Error('target_files must contain at most 32 project-relative paths.');
  }
  const mentionedUrls = [...new Set((task.match(/https?:\/\/[^\s\])}>"']+/gi) || [])
    .map(found => found.replace(/[.,;!?]+$/, '')))];
  if (url !== undefined && (typeof url !== 'string' || !url.trim())) throw new Error('url must be a web address.');
  if (mentionedUrls.length > 1 || url && mentionedUrls.some(mentioned => mentioned !== url)) {
    throw new Error('Delegate one web URL per sub-agent call.');
  }
  const sourceUrl = url ?? mentionedUrls[0];
  if (sourceUrl && target_files.length) throw new Error('Choose one web URL or project files for a sub-agent call.');
  if (!sourceUrl && !target_files.length) throw new Error('Provide one URL or target_files for the sub-agent to inspect.');
  const instruction = [task, expected_output && `Expected output: ${expected_output}`,
    constraint && `Constraint: ${constraint}`, 'Return only a concise answer. Do not include raw source content.']
    .filter(Boolean).join('\n');
  const runner = require('../subAgentRunner');
  const summary = sourceUrl
    ? await runner.extractWebPageData({ url: sourceUrl, query: instruction, engine, signal })
    : await runner.runSubAgent({ task_description: instruction, target_files, rootPath, engine, signal });
  return summary.length > 1800 ? `${summary.slice(0, 1780)}\n[Summary truncated]` : summary;
}

module.exports = { spawnSubagentTool, executeSpawnSubagent };
