'use strict';

const { spawn } = require('node:child_process');
const active = new Set();
const STREAM_LIMIT = 16384;
const GRACE_MS = 250;

// Bound while reading, including single enormous lines. Never buffer the whole
// command output; preserve both startup context and the final diagnostics.
function capture() {
  let head = '', tail = '', total = 0;
  return {
    add(chunk) {
      total += chunk.length;
      const needed = Math.max(0, STREAM_LIMIT / 2 - head.length);
      head += chunk.slice(0, needed);
      tail = (tail + chunk.slice(needed)).slice(-STREAM_LIMIT / 2);
    },
    get truncated() { return total > STREAM_LIMIT; },
    text() { return head + (total > STREAM_LIMIT ? '\n[... output truncated ...]\n' : '') + tail; },
  };
}

function runForeground(file, argv, { cwd, env, signal, timeoutMs, requestedTimeoutMs = timeoutMs, timeoutReason = 'timed_out', windowsVerbatimArguments = false, onState = null, validateAuthorization = null }) {
  const started = performance.now();
  return new Promise(resolve => {
    const stdout = capture(), stderr = capture();
    let child, timer, forceTimer, finishTimer, revocationTimer, status, code = null, exitSignal = null, spawnError = null, settled = false;
    const kill = force => {
      if (!child?.pid) return;
      if (process.platform === 'win32') {
        // Same tree ownership convention as Electron's engine cleanup.
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', ...(force ? ['/F'] : [])], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => {});
        return;
      }
      try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH') spawnError = error.code; }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(finishTimer);
      clearInterval(revocationTimer);
      signal?.removeEventListener('abort', abort);
      active.delete(stop);
      child?.stdout?.destroy(); child?.stderr?.destroy();
      resolve({ stdout: stdout.text(), stderr: stderr.text(), exitCode: code,
        status: status ?? (spawnError ? 'spawn_failed' : code === 0 ? 'completed' : 'nonzero_exit'),
        signal: exitSignal, duration_ms: Math.round(performance.now() - started),
        timeout_ms: timeoutMs, requested_timeout_ms: requestedTimeoutMs,
        output_truncated: stdout.truncated || stderr.truncated,
        ...(status === 'timed_out' ? { timedOut: true } : {}),
        ...(status === 'cancelled' ? { cancelled: true } : {}),
        ...(spawnError ? { spawnError } : {}),
      });
    };
    const stop = reason => {
      if (settled || status) return;
      status = reason;
      clearTimeout(timer);
      kill(false);
      // Do not cancel escalation on shell exit: descendants can ignore TERM
      // after their shell has exited or closed its inherited output handles.
      forceTimer = setTimeout(() => {
        kill(true);
        finishTimer = setTimeout(finish, 100);
      }, GRACE_MS);
    };
    const abort = () => stop(signal?.reason?.code === 'SUBAGENT_DEADLINE_EXCEEDED' ? 'agent_deadline_exceeded' : 'cancelled');
    if (signal?.aborted) { abort(); finish(); return; }
    try {
      child = spawn(file, argv, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { spawnError = error.code ?? 'SPAWN_FAILED'; finish(); return; }
    active.add(stop);
    const report = () => { try { onState?.({ status: 'running', process_id: child.pid, timeout_ms: timeoutMs, process_started_at: new Date().toISOString(), stdout: stdout.text(), stderr: stderr.text(), output_truncated: stdout.truncated || stderr.truncated }); } catch {} };
    child.once('spawn', report);
    onState?.({ readOutput: () => ({ stdout: stdout.text(), stderr: stderr.text(), output_truncated: stdout.truncated || stderr.truncated }) });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout.add(chunk); });
    child.stderr.on('data', chunk => { stderr.add(chunk); });
    child.stdout.on('error', error => { stderr.add(`Output capture failed: ${error.message}`); stop('output_capture_failed'); });
    child.stderr.on('error', error => { stderr.add(`Output capture failed: ${error.message}`); stop('output_capture_failed'); });
    child.on('error', error => { spawnError = error.code ?? 'SPAWN_FAILED'; stderr.add(error.message); finish(); });
    child.on('exit', (exitCode, sig) => {
      code = exitCode; exitSignal = sig;
      // Even a successful foreground shell must not leave background children.
      if (!status) {
        clearTimeout(timer);
        if (process.platform !== 'win32') {
          try { process.kill(-child.pid, 0); }
          catch (error) {
            if (error.code === 'ESRCH') {
              // Normally close follows immediately. Escaped processes holding
              // inherited pipes must not leave this foreground promise open.
              finishTimer = setTimeout(finish, 100);
              return;
            }
          }
        }
        kill(false);
        forceTimer = setTimeout(() => { kill(true); finishTimer = setTimeout(finish, 100); }, GRACE_MS);
      }
    });
    child.on('close', () => {
      // Keep the tree cleanup grace period even when all pipes close early.
      if (!forceTimer) finish();
    });
    timer = setTimeout(() => stop(timeoutReason), timeoutMs);
    if (validateAuthorization) revocationTimer = setInterval(() => {
      try { validateAuthorization(); } catch { stop('cancelled'); }
    }, 50);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

async function shutdownForegroundCommands() {
  for (const stop of active) stop('cancelled');
  while (active.size) await new Promise(resolve => setTimeout(resolve, 10));
}
module.exports = { runForeground, shutdownForegroundCommands, STREAM_LIMIT, GRACE_MS };
