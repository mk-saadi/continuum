'use strict';
function decision({ inputTokens, usableInput, projectedGrowth = 0, uncoveredOperations = 0, uncoveredTokens = 0, unchanged = false }) {
  const growth = Math.min(Math.ceil(usableInput * .15), Math.max(0, projectedGrowth));
  const recovery = Math.min(3072, Math.ceil(usableInput * .12));
  const margin = growth + recovery + 128;
  const meaningful = uncoveredOperations >= 24 || uncoveredTokens >= Math.min(12000, usableInput / 3);
  const threatened = usableInput - inputTokens <= margin;
  return { trigger: !unchanged && meaningful && threatened, margin, growth, recovery,
    reason: unchanged ? 'unchanged-evidence' : !meaningful ? 'insufficient-new-evidence' : threatened ? 'projected-growth-threatens-recovery' : 'safe-headroom' };
}
module.exports = { decision };
