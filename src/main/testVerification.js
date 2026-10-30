'use strict';

// Parse only TAP protocol records at column zero: nested assertions are not
// independent top-level results. Summaries may survive a bounded head/tail cut.
function inspectTap(output, truncated = false) {
  const lines = String(output || '').replace(/\r/g, '').split('\n');
  const records = lines.flatMap(line => {
    const m = /^(not ok|ok) (\d+)(?:\s+-.*)?(?:\s+#.*)?$/.exec(line);
    return m ? [{ id: Number(m[2]), failed: m[1] === 'not ok', skipped: /#\s*(?:TODO|SKIP)\b/i.test(line) }] : [];
  });
  const totals = {};
  for (const line of lines) {
    const m = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line);
    if (m) (totals[m[1]] ??= []).push(Number(m[2]));
  }
  const summary = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].every(k => totals[k]?.length === 1);
  const counts = Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, v[0]]));
  const consistent = summary && counts.tests === counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo;
  const header = lines.includes('TAP version 13');
  const plans = lines.flatMap(line => /^1\.\.(\d+)(?:\s+#.*)?$/.exec(line)?.slice(1).map(Number) || []);
  const sequential = records.every((r, i) => r.id === i + 1);
  const complete = header && !truncated && plans.length === 1 && sequential && records.length === plans[0] && consistent;
  const detected = header || summary || (plans.length > 0 && records.length > 0) || (records.length > 0 && totals.fail?.length === 1 && totals.pass?.length === 1);
  const failures = detected ? Math.max(consistent ? counts.fail + counts.cancelled : 0, records.filter(r => r.failed && !r.skipped).length) : 0;
  return { runner: detected ? 'Node TAP' : null, complete, failures, totals: counts, detected };
}

// Conservative accounting only; never rewrite arbitrary shell commands. Quoted
// data is excluded so e.g. printf 'a|b' remains a direct command.
function mayMaskExit(command) {
  const unquoted = String(command || '').replace(/'[^']*'/g, 'WORD');
  if (/\$\(|`/.test(unquoted)) return true;
  const syntax = String(command || '').replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, 'WORD');
  return /\||&&|;|\n|&|\$\(|`/.test(syntax);
}
function verificationConcern(result, command) {
  if (result?.success === false || ['failed', 'inconclusive', 'error', 'execution_error', 'cancelled', 'timed_out'].includes(result?.status)) return result.status === 'inconclusive' ? 'inconclusive' : 'failed';
  const evidence = result?.testEvidence ?? inspectTap(result?.stdout, result?.output_truncated);
  if (evidence.failures > 0) return 'failed';
  if (result?.exitCode === 0 && ((evidence.detected && !evidence.complete) || (mayMaskExit(command) && !evidence.complete))) return 'inconclusive';
  return null;
}
module.exports = { inspectTap, mayMaskExit, verificationConcern };
