import test from 'node:test';
import assert from 'node:assert/strict';
import { failureDetail } from '../src/lib/executionEvents.mjs';

test('command failures surface stderr, not the exit-code summary', () => {
  const step = {
    type: 'tool_call', toolName: 'execute_command', status: 'error',
    error: 'Command exited with status 2.',
    result: { exitCode: 2, stdout: 'some output\n', stderr: "ls: cannot access 'sms-collector': No such file\n" },
  };
  const detail = failureDetail(step);
  assert.match(detail, /cannot access/);
  assert.doesNotMatch(detail, /Command exited/);
});

test('command failures without stderr add nothing (stdout has its own section)', () => {
  const step = {
    type: 'tool_call', toolName: 'execute_command', status: 'error',
    error: 'Command exited with status 1.',
    result: { exitCode: 1, stdout: 'partial output\n' },
  };
  assert.equal(failureDetail(step), '');
});

test('tool failures surface a richer result.error over the generic banner', () => {
  const step = {
    type: 'tool_call', toolName: 'edit_project_files', status: 'error',
    error: 'A tool call failed.',
    result: { isError: true, error: 'old_str not found in invoice-backend/src/services/authService.js (edit 1 of 2)' },
  };
  assert.match(failureDetail(step), /old_str not found/);
});

test('identical banner and result error produce no duplicate detail', () => {
  const step = {
    type: 'tool_call', toolName: 'read_file', status: 'error',
    error: 'A file path was not found.',
    result: { isError: true, error: 'A file path was not found.' },
  };
  assert.equal(failureDetail(step), '');
});

test('string results differing from the banner are shown', () => {
  const step = {
    type: 'tool_call', toolName: 'search', status: 'error',
    error: 'A tool call failed.', result: 'search backend timed out after 30s',
  };
  assert.match(failureDetail(step), /timed out/);
});

test('missing or empty results yield no detail', () => {
  assert.equal(failureDetail(null), '');
  assert.equal(failureDetail({}), '');
  assert.equal(failureDetail({ type: 'tool_call', error: 'A tool call failed.' }), '');
  assert.equal(failureDetail({ type: 'tool_call', error: 'A tool call failed.', result: {} }), '');
});

test('very long errors are capped', () => {
  const step = {
    type: 'tool_call', status: 'error', error: 'A tool call failed.',
    result: { isError: true, error: `x\n${'y'.repeat(10000)}` },
  };
  const detail = failureDetail(step);
  assert.ok(detail.length < 5000);
  assert.match(detail, /truncated/);
});
