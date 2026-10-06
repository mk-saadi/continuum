'use strict';

const { createSession, completeSession, failSession } = require('./sessionManager');
const { runFileAnalysisExecution, runWebExtractionExecution } = require('./executionManager');

// Subagent runtime: the boundary between the tool layer and subagent executions.
// Each call opens a distinct child session, runs exactly one one-shot execution
// inside it, and records the outcome on that session. Sessions are ephemeral and
// in-memory; loops, background runs, continuation, and messaging are deliberately
// not part of this step.
//
//   tool -> runFileAnalysis/runWebExtraction -> session -> execution
//        -> inference scheduler -> local provider -> local model server

async function runFileAnalysis(options) {
  return runInSession(options, runFileAnalysisExecution);
}

async function runWebExtraction(options) {
  return runInSession(options, runWebExtractionExecution);
}

async function runInSession({ parentSessionId = null, agentId = null, engine, ...executionOptions }, execution) {
  const session = createSession({ parentSessionId, agentId, model: engine?.modelId ?? null });
  try {
    const { output, usage } = await execution({ session, engine, ...executionOptions });
    completeSession(session, usage);
    return output;
  } catch (error) {
    failSession(session, error);
    throw error;
  }
}

module.exports = { runFileAnalysis, runWebExtraction };
