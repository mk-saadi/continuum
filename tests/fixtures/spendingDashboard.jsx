import React from 'react';
import { createRoot } from 'react-dom/client';
import UsageCostsDashboard from '../../src/components/settings/usage/UsageCostsDashboard';

const summary = {
  turns: 6, localTurns: 1, billableTurns: 5,
  inputTokens: 12000, inputCoverage: 'measured', outputTokens: 800, outputCoverage: 'measured',
  totalTokens: 12800, totalTokensCoverage: 'measured',
  cachedInputTokens: 3000, cacheReadCoverage: 'measured', cacheWriteTokens: 500, cacheWriteCoverage: 'measured',
  uncachedInputTokens: 9000, uncachedInputCoverage: 'measured', reasoningTokens: null, reasoningCoverage: 'unavailable',
  cacheSavings: 0.0042, cacheWriteCost: 0.001, savingsCoverage: 'measured', cacheHitRatio: 25,
  costMeasuredTurns: 5, authoritativeTurns: 2, estimatedTurns: 3, unknownCostTurns: 0,
  costCoverage: 'measured', providerReportedCoverage: 'partially_measured', estimatedCoverage: 'partially_measured',
  dataCompleteness: 'estimated', modelsUsed: 4, currency: 'USD',
  combinedSpend: 0.0183, estimatedSpend: 0.0121, providerReportedSpend: 0.0062,
};

const timeline = [
  { period: '2026-06-28', turns: 4, billableTurns: 4, localTurns: 0, inputTokens: 9000, outputTokens: 600,
    cachedInputTokens: 3000, cacheSavings: 0.0042, estimatedCost: 0.0121, providerReported: 0.003,
    totalCost: 0.0151, unknownCostTurns: 0, costCoverage: 'measured', providerReportedCoverage: 'partially_measured' },
  { period: '2026-06-29', turns: 1, billableTurns: 1, localTurns: 0, inputTokens: 2000, outputTokens: 150,
    cachedInputTokens: 0, cacheSavings: null, estimatedCost: 0, providerReported: 0.0032,
    totalCost: 0.0032, unknownCostTurns: 0, costCoverage: 'measured', providerReportedCoverage: 'measured' },
  { period: '2026-06-30', turns: 1, billableTurns: 0, localTurns: 1, inputTokens: 1000, outputTokens: 50,
    cachedInputTokens: 0, cacheSavings: null, estimatedCost: 0, providerReported: 0,
    totalCost: null, unknownCostTurns: 0, costCoverage: 'not_applicable', providerReportedCoverage: 'not_applicable' },
];

const anthropicModel = {
  key: 'anthropic-p\u001fclaude-sonnet-5', modelId: 'claude-sonnet-5', providerId: 'anthropic-p',
  providerLabel: 'Claude', providerFamily: 'anthropic', providerFamilyLabel: 'Direct Anthropic',
  estimatedSpend: 0.0121, providerReportedSpend: 0.003, combinedSpend: 0.0151,
  costCoverage: 'measured', providerReportedCoverage: 'partially_measured', estimatedCoverage: 'partially_measured',
  cacheSavings: 0.0042, savingsCoverage: 'measured', cacheWriteCost: 0.001,
  inputTokens: 9000, inputCoverage: 'measured', cachedInputTokens: 3000, cacheReadCoverage: 'measured',
  cacheWriteTokens: 500, cacheWriteCoverage: 'measured', uncachedInputTokens: 6000, uncachedInputCoverage: 'measured',
  outputTokens: 600, outputCoverage: 'measured', totalTokens: 9600, totalTokensCoverage: 'measured',
  reasoningTokens: null, reasoningCoverage: 'unavailable', cacheHitRatio: 33.3,
  turns: 4, billableTurns: 4, localTurns: 0, authoritativeTurns: 1, estimatedTurns: 3,
  unknownCostTurns: 0, dataCompleteness: 'estimated',
};

const gptModel = {
  ...anthropicModel,
  key: 'openai-p\u001fgpt-5', modelId: 'gpt-5', providerId: 'openai-p', providerLabel: 'OpenAI',
  providerFamily: 'openai', providerFamilyLabel: 'Direct OpenAI',
  estimatedSpend: 0, providerReportedSpend: 0.0032, combinedSpend: 0.0032,
  cacheSavings: 0, inputTokens: 2000, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 150,
  totalTokens: 2150, turns: 1, billableTurns: 1, authoritativeTurns: 1, estimatedTurns: 0,
  dataCompleteness: 'fully_measured', cacheHitRatio: null,
};

const tinyModel = {
  ...gptModel, key: 'or-p\u001ftiny-model', modelId: 'tiny-model', providerId: 'or-p',
  providerLabel: 'OpenRouter', providerFamily: 'openrouter', providerFamilyLabel: 'OpenRouter',
  estimatedSpend: 0.00002, providerReportedSpend: null, combinedSpend: 0.00002,
  providerReportedCoverage: 'unavailable', turns: 0, billableTurns: 0, authoritativeTurns: 0,
  estimatedTurns: 0, totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0,
  outputTokens: 0, cacheSavings: 0, dataCompleteness: 'estimated',
};

const localModel = {
  key: 'local\u001fllama-3', modelId: 'llama-3', providerId: 'local', providerLabel: 'Local models',
  providerFamily: 'local', providerFamilyLabel: 'Local inference',
  estimatedSpend: null, providerReportedSpend: null, combinedSpend: null,
  costCoverage: 'not_applicable', providerReportedCoverage: 'not_applicable', estimatedCoverage: 'not_applicable',
  cacheSavings: null, savingsCoverage: 'not_applicable', inputTokens: 1000, inputCoverage: 'measured',
  cachedInputTokens: null, cacheReadCoverage: 'unavailable', cacheWriteTokens: null, cacheWriteCoverage: 'unavailable',
  outputTokens: 50, outputCoverage: 'measured', totalTokens: 1050, totalTokensCoverage: 'measured',
  reasoningTokens: null, reasoningCoverage: 'unavailable', cacheHitRatio: null,
  turns: 1, billableTurns: 0, localTurns: 1, authoritativeTurns: 0, estimatedTurns: 0,
  unknownCostTurns: 0, dataCompleteness: 'not_applicable',
};

const providers = [
  { providerId: 'anthropic-p', providerLabel: 'Claude', providerFamily: 'anthropic', providerFamilyLabel: 'Direct Anthropic',
    estimatedSpend: 0.0121, providerReportedSpend: 0.003, combinedSpend: 0.0151,
    costCoverage: 'measured', providerReportedCoverage: 'partially_measured',
    totalTokens: 9600, totalTokensCoverage: 'measured', modelsUsed: 1, turns: 4 },
  { providerId: 'openai-p', providerLabel: 'OpenAI', providerFamily: 'openai', providerFamilyLabel: 'Direct OpenAI',
    estimatedSpend: 0, providerReportedSpend: 0.0032, combinedSpend: 0.0032,
    costCoverage: 'measured', providerReportedCoverage: 'measured',
    totalTokens: 2150, totalTokensCoverage: 'measured', modelsUsed: 1, turns: 1 },
  { providerId: 'local', providerLabel: 'Local models', providerFamily: 'local', providerFamilyLabel: 'Local inference',
    estimatedSpend: null, providerReportedSpend: null, combinedSpend: null,
    costCoverage: 'not_applicable', providerReportedCoverage: 'not_applicable',
    totalTokens: 1050, totalTokensCoverage: 'measured', modelsUsed: 1, turns: 1 },
];

const filterOptions = {
  providers: [
    { providerId: 'anthropic-p', label: 'Claude', family: 'anthropic', familyLabel: 'Direct Anthropic' },
    { providerId: 'openai-p', label: 'OpenAI', family: 'openai', familyLabel: 'Direct OpenAI' },
    { providerId: 'or-p', label: 'OpenRouter', family: 'openrouter', familyLabel: 'OpenRouter' },
    { providerId: 'local', label: 'Local models', family: 'local', familyLabel: 'Local inference' },
  ],
  models: [
    { modelId: 'claude-sonnet-5', providerId: 'anthropic-p', providerLabel: 'Claude', label: 'claude-sonnet-5' },
    { modelId: 'gpt-5', providerId: 'openai-p', providerLabel: 'OpenAI', label: 'gpt-5' },
    { modelId: 'llama-3', providerId: 'local', providerLabel: 'Local models', label: 'llama-3' },
  ],
  projects: [{ projectId: 'p1', name: 'Workspace one' }],
};

const normal = {
  filters: { range: '30d', groupBy: 'day', providerId: null, modelId: null, projectId: null, chatId: null, from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T12:00:00.000Z' },
  range: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T12:00:00.000Z', groupBy: 'day', timezone: 'UTC' },
  summary, timeline, models: [anthropicModel, gptModel, tinyModel, localModel], providers, filterOptions,
};

const localSummary = {
  ...summary, turns: 1, billableTurns: 0, localTurns: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0,
  cachedInputTokens: 0, cacheWriteTokens: 0, uncachedInputTokens: 0, cacheSavings: null, cacheWriteCost: null,
  costMeasuredTurns: 0, authoritativeTurns: 0, estimatedTurns: 0, unknownCostTurns: 0,
  costCoverage: 'not_applicable', providerReportedCoverage: 'not_applicable', estimatedCoverage: 'not_applicable',
  savingsCoverage: 'not_applicable', cacheReadCoverage: 'unavailable', cacheWriteCoverage: 'unavailable',
  cacheHitRatio: null, dataCompleteness: 'not_applicable', modelsUsed: 1,
  combinedSpend: null, estimatedSpend: null, providerReportedSpend: null,
};
const localOnly = {
  ...normal, summary: localSummary, models: [localModel], providers: [providers[2]],
  timeline: [{ ...timeline[2], turns: 1, localTurns: 1 }],
};

const pricingRow = {
  key: 'anthropic-p\u001fclaude-sonnet-5\u001fanthropic-catalog', providerId: 'anthropic-p', providerLabel: 'Claude',
  providerFamily: 'anthropic', providerFamilyLabel: 'Direct Anthropic', modelId: 'claude-sonnet-5', modelLabel: 'claude-sonnet-5',
  source: 'anthropic-catalog', pricingKind: 'Verified catalog rate', version: 'anthropic-catalog:2026-04-01', currency: 'USD',
  rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 }, missing: [],
  firstSeen: '2026-06-01T00:00:00.000Z', lastSeen: '2026-06-28T10:00:00.000Z', effectiveAt: null, turns: 4, recordedCost: 0.0151,
};
const providerPricingRow = {
  ...pricingRow, key: 'openai-p\u001fvendor/model\u001fprovider-reported', providerId: 'openai-p', providerLabel: 'OpenAI',
  providerFamily: 'openai', providerFamilyLabel: 'Direct OpenAI', modelId: 'vendor/model', modelLabel: 'vendor/model',
  source: 'provider-reported', pricingKind: 'Authoritative provider charge', version: 'provider-charge',
  rates: null, missing: [], firstSeen: '2026-06-29T09:00:00.000Z', lastSeen: '2026-06-29T09:00:00.000Z', turns: 1, recordedCost: 0.0032,
};

const attribution = {
  chat: [
    { key: 'chat-1', label: 'Chat one', turns: 5, totalTokens: 11000, totalTokensCoverage: 'measured',
      estimatedSpend: 0.0121, providerReportedSpend: 0.003, combinedSpend: 0.0151, costCoverage: 'measured',
      providerFamily: 'anthropic' },
    { key: 'chat-2', label: 'Chat two', turns: 1, totalTokens: 1800, totalTokensCoverage: 'measured',
      estimatedSpend: 0, providerReportedSpend: 0.0032, combinedSpend: 0.0032, costCoverage: 'measured',
      providerFamily: 'openai' },
  ],
  agent: [
    { key: 'main', label: 'Main agent', turns: 5, totalTokens: 12000, totalTokensCoverage: 'measured',
      estimatedSpend: 0.0121, providerReportedSpend: 0.003, combinedSpend: 0.0151, costCoverage: 'measured',
      providerFamily: 'anthropic' },
    { key: 'subagent:Researcher', label: 'Subagent · Researcher', turns: 1, totalTokens: 800, totalTokensCoverage: 'measured',
      estimatedSpend: 0, providerReportedSpend: 0.0032, combinedSpend: 0.0032, costCoverage: 'measured',
      providerFamily: 'openai' },
  ],
};

const records = {
  rows: [
    { occurred_at: '2026-06-28T10:00:00.000Z', kind: 'turn', chat_id: 'chat-1', chatLabel: 'Chat one',
      workspaceLabel: 'Workspace one', providerLabel: 'Claude', providerFamily: 'anthropic', modelLabel: 'claude-sonnet-5',
      total_tokens: 9600, cost_total: 0.0151, cost_completeness: 'complete', cost_source: 'anthropic-catalog' },
    { occurred_at: '2026-06-29T09:00:00.000Z', kind: 'subagent', chat_id: 'chat-2', chatLabel: 'Chat two',
      workspaceLabel: 'Unattributed', providerLabel: 'OpenAI', providerFamily: 'openai', modelLabel: 'gpt-5',
      total_tokens: 2150, cost_total: 0.0032, cost_completeness: 'complete', cost_source: 'provider-reported' },
  ],
  total: 6, limit: 25, offset: 0, hasMore: false,
};

const detail = {
  filters: normal.filters,
  summary: { ...summary, turns: 4, billableTurns: 4, localTurns: 0, combinedSpend: 0.0151,
    estimatedSpend: 0.0121, providerReportedSpend: 0.003, costCoverage: 'measured',
    providerReportedCoverage: 'partially_measured', estimatedCoverage: 'partially_measured' },
  timeline, model: anthropicModel, pricing: [pricingRow],
};

window.queries = [];
window.inferenceCalls = 0;
const record = (method, options) => { window.queries.push({ method, options }); };
window.api = {
  getSpendingDashboard: async options => {
    record('getSpendingDashboard', options);
    if (options.providerId === 'error-p') throw new Error('Dashboard unavailable for this selection.');
    if (options.providerId === 'local') return localOnly;
    return normal;
  },
  getSpendingAttribution: async options => {
    record('getSpendingAttribution', options);
    return { groupBy: options.groupBy, rows: attribution[options.groupBy] ?? attribution.chat };
  },
  getSpendingRecords: async options => {
    record('getSpendingRecords', options);
    return records;
  },
  getPricingHistory: async options => {
    record('getPricingHistory', options);
    return { rows: [pricingRow, providerPricingRow], total: 2, limit: 25, offset: 0, hasMore: false };
  },
  getUsageModelDetail: async options => {
    record('getUsageModelDetail', options);
    return detail;
  },
};

createRoot(document.getElementById('root')).render(<UsageCostsDashboard />);
