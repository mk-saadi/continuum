// Run with ELECTRON_RUN_AS_NODE unset under xvfb-run electron --no-sandbox.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'approval-toast-'));
  const win = new BrowserWindow({ show: true, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ToastProvider, useToast } from 'react-toast-master';
      import 'react-toast-master/dist/style.css';
      import ToolApprovalToast from './src/components/main-app/ToolApprovalToast.jsx';
      window.responses = []; window.failNext = false;
      window.chatAPI = { respondToToolApproval: async (...args) => {
        window.responses.push(args);
        if (window.failNext) { window.failNext = false; throw Error('Please retry'); }
      }};
      function Harness() {
        const {toastMaster, hideToast} = useToast();
        window.notify = () => { toastMaster({type:'custom',custom:<p>Other notice</p>}); setTimeout(hideToast, 30); };
        return <ToolApprovalToast approval={window.approval} />;
      }
      const root = createRoot(document.getElementById('root'));
      window.mount = id => {
        window.approval = { requestId:'request', approvalId:id, name:'git_sync', args:{ command:'python3 ' + 'long_path/'.repeat(90), execution_scope:'Host filesystem access' }, rememberable:true, rememberLabel:'Remember this decision' };
        root.render(<React.StrictMode><ToastProvider key={id}><Harness /></ToastProvider></React.StrictMode>);
      };
      window.mount('first');
    ` }, bundle: true, jsx: 'automatic', outfile: path.join(directory, 'app.js') });
    await fs.writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="app.css"><div id="root"></div><script src="app.js"></script>');
    await win.loadFile(path.join(directory, 'index.html'));
    await win.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const check = (value, message) => { if (!value) throw Error(message); };
      const card = () => document.querySelector('[role="alertdialog"]');
      const click = label => [...card().querySelectorAll('button')].find(button => button.textContent.trim() === label).click();
      await wait(150);
      check(document.querySelectorAll('[role="alertdialog"]').length === 1, 'StrictMode creates one approval');
      check(card().closest('.outer_container'), 'approval uses the package custom toast');
      const bounds = card().getBoundingClientRect();
      const wrapper = card().closest('.max_width').getBoundingClientRect();
      check(bounds.left >= 0 && bounds.right <= innerWidth, 'approval fits viewport');
      check(bounds.left >= wrapper.left - 1 && bounds.right <= wrapper.right + 1, 'wrapper does not clip approval');
      check(getComputedStyle(card()).borderLeftWidth === '1px' && getComputedStyle(card()).borderTopWidth === '1px', 'approval has an even thin border');
      document.documentElement.dataset.style = 'skeu';
      const skeuBorder = getComputedStyle(card());
      check(skeuBorder.borderLeftColor === skeuBorder.borderTopColor, 'Skeu approval outline is neutral on every side');
      check(skeuBorder.borderLeftWidth === skeuBorder.borderTopWidth, 'Skeu approval has no thicker stripe');
      delete document.documentElement.dataset.style;
      check(card().querySelector('.app-approval-deny').parentElement.className === 'app-approval-actions', 'Deny shares the approval action row');
      check(getComputedStyle(card().querySelector('.app-approval-deny')).boxShadow === 'none', 'Deny has no button relief');
      check(card().querySelector('pre').scrollWidth <= card().querySelector('pre').clientWidth + 1, 'long command wraps');
      window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));
      await wait(450); check(card(), 'Escape must not dismiss unanswered approval');
      window.notify(); await wait(500); check(card(), 'regular toast dismissal must not hide approval');
      window.failNext = true; click('Allow once'); await wait(80);
      check(card()?.querySelector('[role="alert"]')?.textContent === 'Please retry', 'failed decision remains retryable');
      click('Deny'); await wait(500);
      check(!card(), 'successful decision closes approval');
      check(window.responses[1].join('|') === 'request|first|deny', 'deny keeps original routing');
      for (const [id, label, action] of [['second','Allow once','allow'],['third','Allow for this chat','chat'],['fourth','Always allow in this project','project']]) {
        window.mount(id); await wait(120); click(label); await wait(500);
        check(window.responses.at(-1).join('|') === ['request',id,action].join('|'), 'decision routing: '+action);
        check(!card(), 'resolved approval dismissed: '+action);
      }
      window.mount('queued'); await wait(120); check(card(), 'next queued approval renders');
    })()`);
    win.setSize(360, 560);
    await new Promise(resolve => setTimeout(resolve, 100));
    await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('[role="alertdialog"]');
      const bounds = card.getBoundingClientRect();
      if (bounds.left < 0 || bounds.right > innerWidth || card.scrollWidth > card.clientWidth + 1) throw Error('narrow approval clipped');
    })()`);
    console.log('PASS: custom toast, StrictMode, Escape, notification isolation, retry, decision routing, and next approval.');
  } finally { win.destroy(); await fs.rm(directory, { recursive:true, force:true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
