'use strict';

const spawnSubagentTool = {
  type: 'function',
  function: {
    name: 'spawn_subagent',
    description: `DELEGATED WORKER. CRITICAL CONSTRAINTS:
- DO NOT use this tool to search, read, inspect, or parse local workspace files or source code repositories. Use 'execute_command' (grep, ripgrep, cat, find, sed) instead.
- ONLY use this tool for isolated web research on one public URL. It returns a concise answer from a bounded page excerpt.`,
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Clear, specific web research question for the worker.' },
        constraint: { type: 'string', description: 'Optional length and omission rules, such as no raw HTML or boilerplate.' },
        expected_output: { type: 'string', description: 'Requested summary format, such as a markdown table and two sentences.' },
        url: { type: 'string', description: 'Optional explicit public HTTP or HTTPS URL; one URL per invocation.' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
};

const LOCAL_FILE_ERROR = "Do NOT use sub-agents for file inspection. Use 'execute_command' with 'grep -n', 'ripgrep', or 'sed' to query local files directly.";

async function executeSpawnSubagent({ task, constraint = '', expected_output = '', url, target_files,
  engine, signal }) {
  if (typeof task !== 'string' || !task.trim() || task.length > 2000 || task.includes('\0')) {
    throw new Error('Sub-agent task must be a non-empty instruction of at most 2,000 characters.');
  }
  for (const [name, value] of Object.entries({ constraint, expected_output })) {
    if (typeof value !== 'string' || value.length > 1000 || value.includes('\0')) {
      throw new Error(`${name} must be a string of at most 1,000 characters.`);
    }
  }
  if (target_files !== undefined) throw new Error(LOCAL_FILE_ERROR);
  const mentionedUrls = [...new Set((task.match(/https?:\/\/[^\s\])}>"']+/gi) || [])
    .map(found => found.replace(/[.,;!?]+$/, '')))];
  if (url !== undefined && (typeof url !== 'string' || !url.trim())) throw new Error('url must be a web address.');
  if (mentionedUrls.length > 1 || url && mentionedUrls.some(mentioned => mentioned !== url)) {
    throw new Error('Delegate one web URL per sub-agent call.');
  }
  const sourceUrl = url ?? mentionedUrls[0];
  if (!sourceUrl) throw new Error(`Provide one public web URL. ${LOCAL_FILE_ERROR}`);
  const instruction = [task, expected_output && `Expected output: ${expected_output}`,
    constraint && `Constraint: ${constraint}`, 'Return only a concise answer. Do not include raw source content.']
    .filter(Boolean).join('\n');
  const runner = require('../subAgentRunner');
  const summary = await runner.extractWebPageData({ url: sourceUrl, query: instruction, engine, signal });
  return summary.length > 1800 ? `${summary.slice(0, 1780)}\n[Summary truncated]` : summary;
}

module.exports = { spawnSubagentTool, executeSpawnSubagent };
