import test from 'node:test';
import assert from 'node:assert/strict';
import { isSummarizingError, summarizeNoticeFor } from '../src/lib/summarizeNotice.mjs';

test('summarizing lock is detected regardless of wrapping', () => {
  assert.equal(isSummarizingError(new Error('History is being summarized. Please retry shortly.')), true);
  assert.equal(isSummarizingError(new Error("Could not save reply: Error: History is being summarized. Please retry shortly.")), true);
  assert.equal(isSummarizingError(new Error('Something else failed')), false);
  assert.equal(isSummarizingError(null), false);
  assert.equal(isSummarizingError(undefined), false);
});

test('casual chats get a short notice only for the summarizing lock', () => {
  const notice = summarizeNoticeFor({ message: 'History is being summarized. Please retry shortly.', isWorkspaceChat: false });
  assert.ok(typeof notice === 'string' && notice.length > 0 && notice.length < 140);
  assert.match(notice, /summariz/i);
  assert.equal(summarizeNoticeFor({ message: 'Disk full', isWorkspaceChat: false }), null);
  assert.equal(summarizeNoticeFor({ message: '', isWorkspaceChat: false }), null);
  assert.equal(summarizeNoticeFor({ message: null, isWorkspaceChat: false }), null);
});

test('workspace chats never get the quiet notice', () => {
  assert.equal(summarizeNoticeFor({ message: 'History is being summarized. Please retry shortly.', isWorkspaceChat: true }), null);
});
