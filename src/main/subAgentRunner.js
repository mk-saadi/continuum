'use strict';

// Compatibility facade for the legacy delegation paths (delegate_task,
// extract_web_page_data, spawn_sub_agent tests, and existing imports). The one
// source of truth now lives in ./subagents:
//
//   subAgentRunner -> subagents runtime -> session -> execution -> local provider
//
// Requiring this module also loads ./subagents, which installs the GET-only
// global.fetch override for sub-agent web GETs, exactly as before.
const { localEngineFetch } = require('./localEngineFetch');
const { runFileAnalysis, runWebExtraction } = require('./subagents');
const { SUB_AGENT_SYSTEM_PROMPT, resolveTargetFiles, targetFileBudget } = require('./subagents/executionManager');
const { resolveSubAgentPath } = require('./pathUtils');

/** One awaited completion on the existing server; no new process, model, tools, or history. */
async function runSubAgent({ parentSessionId = null, fetchImpl = localEngineFetch, ...options }) {
  return runFileAnalysis({ ...options, parentSessionId, fetchImpl });
}

/** Fetch one bounded page and ask the loaded model in a throwaway two-message context. */
async function extractWebPageData({ parentSessionId = null, fetchImpl = localEngineFetch, ...options }) {
  return runWebExtraction({ ...options, parentSessionId, fetchImpl });
}

module.exports = { runSubAgent, extractWebPageData, SUB_AGENT_SYSTEM_PROMPT, resolveSubAgentPath, resolveTargetFiles, targetFileBudget };
