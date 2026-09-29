// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/chatInputPerformance.ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'chat-input-ui-'));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { contents: `
      import React, { useState, useRef } from 'react';
      import { createRoot } from 'react-dom/client';
      import ChatInput from './src/components/ChatInput';
      import ChatMessage from './src/components/ChatMessage';
      window.parentRenders = 0; window.messageReads = 0; window.submissions = [];
      const message = { id: 'reply', role: 'assistant', get content() { window.messageReads++; return '**Existing reply**'; } };
      const root = createRoot(document.getElementById('root'));
      function Fixture() {
        window.parentRenders++;
        const [sessionId, setSessionId] = useState('a');
        const [visible, setVisible] = useState(true);
        const [counter, setCounter] = useState(0);
        const inputRef = useRef(null);
        window.switchChat = setSessionId;
        window.hideInput = () => setVisible(false);
        window.parentUpdate = () => setCounter(value => value + 1);
        window.clearSubmitted = (text, id = sessionId) => inputRef.current.clearSubmitted(text, id);
        return <><span>{counter}</span><ChatMessage message={message} />
          {visible && <ChatInput ref={inputRef} sessionId={sessionId} canSubmit sendTitle="Send"
            onSubmit={text => window.submissions.push(text)} />}</>;
      }
      root.render(<Fixture />);
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (condition, message) => { if (!condition) throw new Error(message); };
      for (let i = 0; i < 50 && !document.querySelector('textarea'); i++) await wait();
      await wait();
      const type = text => {
        const input = document.querySelector('textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const originalSet = Storage.prototype.setItem;
      const writes = [];
      Storage.prototype.setItem = function(key, value) { writes.push([key, value]); originalSet.call(this, key, value); };
      const parents = window.parentRenders, reads = window.messageReads;
      for (const text of ['H', 'He', 'Hello']) { type(text); await wait(); }
      check(writes.length === 0, 'No synchronous storage writes during typing');
      check(window.parentRenders === parents, 'Typing does not rerender the parent');
      check(window.messageReads === reads, 'Typing does not rerender existing messages');
      await wait(600); check(writes.length === 0, 'Debounce has not fired early');
      type('Hello world'); await wait(600); check(writes.length === 0, 'A new keystroke cancels the old timeout');
      await wait(500); check(writes.length === 1 && writes[0][1] === 'Hello world', 'One write after a pause');
      window.parentUpdate(); await wait(); check(window.messageReads === reads, 'Memo skips unrelated parent renders');
      const input = document.querySelector('textarea');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
      await wait(); check(window.submissions.length === 0, 'IME Enter is not submitted');
      document.querySelector('[aria-label=Send]').click(); await wait();
      check(window.submissions[0] === 'Hello world', 'Only submit sends the final string');
      type('Next draft'); await wait();
      window.clearSubmitted('Hello world'); await wait();
      check(input.value === 'Next draft', 'Late submission acknowledgement preserves new typing');
      window.switchChat('b'); await wait();
      check(input.value === '', 'New session has a separate draft');
      check(localStorage.getItem('chat_draft_a') === 'Next draft', 'Switch flushes unsaved draft to its original key');
      type('Draft B'); await wait(); window.switchChat('a'); await wait();
      check(input.value === 'Next draft', 'Returning restores the draft');
      window.clearSubmitted('Next draft'); await wait(1100);
      check(input.value === '' && localStorage.getItem('chat_draft_a') === null, 'Sent draft stays cleared after pending timer');
      check(localStorage.getItem('chat_draft_b') === 'Draft B', 'Other draft unaffected');
      type('Leaving'); await wait(); window.hideInput(); await wait();
      const count = writes.length;
      await wait(1100);
      check(localStorage.getItem('chat_draft_a') === 'Leaving' && writes.length === count, 'Unmount flushes once and cancels timeout');
    })()`);
    console.log('Debounced storage, isolated typing, memoized messages, IME, session switching, send clearing, and unmount cleanup passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
