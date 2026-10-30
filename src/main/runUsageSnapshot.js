'use strict';

// Live snapshots describe completed requests plus the current request, never a
// delta. Replace the prior snapshot rather than adding it again.
function runUsageSnapshot({ phases = [], current, estimates, previous = null, now = Date.now() }) {
    const requests = [...phases, current];
    const known = estimates.filter(value => Number.isFinite(value.totalCost));
    const sum = key => {
        const values = requests.map(value => value?.[key]).filter(Number.isFinite);
        return values.length ? values.reduce((total, value) => total + value, 0) : null;
    };
    const promptTokens = sum('promptTokens'), completionTokens = sum('completionTokens');
    const startTime = previous?.startTime ?? requests[0]?.startTime ?? now;
    return {
        startTime, endTime: now, time: Math.max(0, (now - startTime) / 1000),
        promptTokens, completionTokens,
        totalTokens: promptTokens == null || completionTokens == null ? null : promptTokens + completionTokens,
        tokensPerSecond: null,
        cachedTokens: sum('cachedTokens'), cacheCreationTokens: sum('cacheCreationTokens'),
        reasoningTokens: sum('reasoningTokens'), visibleCompletionTokens: sum('visibleCompletionTokens'),
        inputCoverage: 'estimated', outputCoverage: 'estimated', usageCoverage: 'estimated',
        cost: known.length ? {
            total: known.reduce((sum, value) => sum + value.totalCost, 0), currency: 'USD',
            completeness: known.length !== estimates.length || known.some(value => value.completeness === 'partial') ? 'partial' : 'estimated',
            estimated: true, source: 'live-usage',
        } : previous?.cost ?? { total: null, currency: 'USD', completeness: 'unavailable' },
    };
}

module.exports = { runUsageSnapshot };
