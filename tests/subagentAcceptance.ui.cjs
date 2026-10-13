// Real Electron controls + production preload/IPC/SQLite and child runtime.
// Model replies are deterministic fixtures; this is not live inference proof.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'subagent-acceptance-ui-'));
  app.setPath('userData', directory);
  const database = require('../src/main/db'); database.initDatabase(directory);
  const settings = require('../src/main/subagents/budgetSettings');
  const runtime = require('../src/main/subagents');
  const engine = { provider: 'local', port: 9, modelId: 'acceptance-fixture', contextLength: 32768 };
  const reply = (content, tool_calls, usage = { prompt_tokens: 50, completion_tokens: 10 }) =>
    Response.json({ choices: [{ finish_reason: tool_calls ? 'tool_calls' : 'stop', message: { content, tool_calls } }], usage });
  const cases = {};
  async function run(name, responses, extra = {}) {
    let id, error = null;
    try {
      await runtime.runInvestigation({ task: 'Inspect this isolated fixture read-only.', rootPath: directory, engine,
        fetchImpl: async () => { assert.ok(responses.length, 'unexpected generation'); return responses.shift(); },
        onSpawn: value => { id = value; }, ...extra });
    } catch (cause) { error = cause.message; }
    cases[name] = { id, error, transcript: runtime.getChildTranscript(id) };
  }
  let window, dispose;
  try {
    await run('completed', [reply('Fixture complete.')]);
    await run('unavailable', [Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'No usage reported.' } }] })]);
    settings.saveBudgetSettings({ mode: 'custom', maxToolCalls: 1, maxTurns: 3 });
    await run('partial', [reply(null, [0, 1, 2].map(i => ({ id: `call-${i}`, type: 'function',
      function: { name: 'list_directory', arguments: JSON.stringify({ relative_path: '.' }) } }))), reply('Read the directory; remaining reads are incomplete.')]);
    await run('failed', [new Response('fixture provider unavailable', { status: 500 })]);
    const controller = new AbortController(); controller.abort(new DOMException('Acceptance cancellation', 'AbortError'));
    await run('cancelled', [], { signal: controller.signal });
    assert.equal(cases.completed.transcript.status, 'completed');
    assert.equal(cases.partial.transcript.status, 'partial');
    assert.equal(cases.partial.transcript.accounting.blockedCalls, 2);
    assert.equal(cases.failed.transcript.status, 'failed');
    assert.equal(cases.cancelled.transcript.status, 'cancelled');
    settings.saveBudgetSettings({ mode: 'auto', maxToolCalls: null, maxTurns: null });
    dispose = require('../src/main/ipcHandlers').registerIpcHandlers({
      isTrustedSender: event => event.sender === window?.webContents, getEngineConfig: () => null,
    });
    await esbuild.build({ stdin: { contents: `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import SubagentBudgetSettings from './src/components/SubagentBudgetSettings';
      import SubagentTranscriptModal from './src/components/chat/SubagentTranscriptModal';
      const settingsRoot=createRoot(document.getElementById('settings'));
      const modalRoot=createRoot(document.getElementById('modal'));
      window.renderSettings=()=>settingsRoot.render(React.createElement(SubagentBudgetSettings,{key:Date.now()}));
      window.openChild=id=>modalRoot.render(React.createElement(SubagentTranscriptModal,{key:id,childSessionId:id,onClose:()=>modalRoot.render(null)}));
      window.renderSettings();
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const assets = path.join(process.cwd(), 'dist/assets');
    await fs.copyFile(path.join(assets, (await fs.readdir(assets)).find(name => name.endsWith('.css'))), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), '<body style="background:var(--bg-primary);color:var(--text-primary)"><link rel="stylesheet" href="fixture.css"><main style="padding:24px;max-width:800px"><div id="settings"></div><div id="modal"></div></main><script src="fixture.js"></script>');
    window = new BrowserWindow({ show: false, width: 1000, height: 850,
      webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(process.cwd(), 'src/preload.js') } });
    await window.loadFile(path.join(directory, 'index.html'));
    const results = await window.webContents.executeJavaScript(`(async()=>{
      const check=(ok,message)=>{if(!ok)throw Error(message);};
      const tick=ms=>new Promise(r=>setTimeout(r,ms));
      const until=async(predicate)=>{for(let i=0;i<100;i++){if(await predicate())return;await tick(30);}throw Error('UI wait timed out: '+window.stage+'; '+document.body.textContent.slice(0,1600));};
      const field=label=>{const l=[...document.querySelectorAll('#settings label')].find(x=>x.textContent===label);return l&&document.getElementById(l.htmlFor);};
      const mode=async(label)=>{window.stage='mode '+label;await until(()=>!field('Sub-agent execution budgets').disabled);field('Sub-agent execution budgets').click();await until(()=>document.querySelector('[role="option"]'));[...document.querySelectorAll('[role="option"]')].find(x=>x.textContent===label).click();await until(async()=> (await window.api.getSubagentBudgets()).settings.mode===(label.startsWith('Custom')?'custom':'auto')&&!field('Sub-agent execution budgets').disabled&&field('Sub-agent execution budgets').textContent.includes(label)&&!document.querySelector('[role="listbox"]'));};
      window.stage='initial Settings';await until(()=>field('Sub-agent execution budgets')&&!field('Sub-agent execution budgets').disabled);
      await mode('Custom hard limits');await until(()=>field('Tool calls per child'));
      const setNumber=async(label,value)=>{
        window.stage='number '+label+'='+value;const input=field(label);input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);
        input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
        await tick(40);input.blur();input.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));await tick(100);
      };
      await setNumber('Tool calls per child','2');
      await until(async()=> (await window.api.getSubagentBudgets()).settings.maxToolCalls===2);
      await setNumber('Model requests per child','5');
      await until(async()=> (await window.api.getSubagentBudgets()).settings.maxTurns===5);
      await setNumber('Tool calls per parent run','3');
      await until(async()=> (await window.api.getSubagentBudgets()).settings.maxAggregateToolCalls===3);
      await setNumber('Tool calls per child','');
      await until(async()=> (await window.api.getSubagentBudgets()).settings.maxToolCalls===null);
      await mode('Automatic (recommended)');
      await until(async()=> (await window.api.getSubagentBudgets()).settings.mode==='auto');
      await mode('Custom hard limits');await until(()=>field('Model requests per child')?.value==='5');
      check(field('Tool calls per parent run').value==='3','Custom values survive toggling');
      await setNumber('Tool calls per child','0');
      await until(()=>document.querySelector('#settings [role="alert"]'));
      check((await window.api.getSubagentBudgets()).settings.maxToolCalls===null,'invalid value was not persisted');
      window.stage='Settings remount';window.renderSettings();await until(()=>field('Model requests per child')?.value==='5'&&field('Tool calls per child')?.value==='');
      check(field('Tool calls per child').value==='','null fallback survives remount');
      const cases=${JSON.stringify(Object.fromEntries(Object.entries(cases).map(([name,value])=>[name,value.id])))};
      const text=()=>document.querySelector('dialog')?.textContent??'';
      for(const [name,id] of Object.entries(cases)) {
        window.stage='child '+name;window.openChild(id);await until(()=>text().includes(name==='unknown'||name==='unavailable'?'completed':name));
        if(name==='completed') {check(text().includes('Final answer'),'completed title');check(text().includes('Child model requests: 1 / 8'),'completed request accounting');}
        if(name==='partial') {check(text().includes('partial · tool_limit'),'partial stop reason');check(text().includes('Partial findings'),'partial title');check(text().includes('blocked attempts: 2'),'blocked accounting');check(text().includes('remaining reads are incomplete'),'partial evidence');}
        if(name==='failed') check(text().includes('failed · provider_error'),'provider failure distinct');
        if(name==='cancelled') check(text().includes('cancelled · cancelled'),'cancellation distinct');
        if(name==='unavailable') {check(text().includes('(estimated)'),'missing input is estimated');check(text().includes('(reserved)'),'missing output is reserved');}
        document.querySelector('[aria-label="Close sub-agent activity"]').click();await until(()=>!document.querySelector('dialog'));
      }
      window.openChild(cases.partial);await until(()=>text().includes('Partial findings'));
      return {settings:(await window.api.getSubagentBudgets()).settings,cases};
    })()`);
    const row = database.db.prepare('SELECT value_json FROM app_settings WHERE key = ?').get('subagentBudgets');
    assert.deepEqual(JSON.parse(row.value_json), results.settings);
    window.showInactive();
    await new Promise(resolve => setTimeout(resolve, 250));
    const screenshot = await window.webContents.capturePage();
    await fs.writeFile('/tmp/phase4-subagent-ui.png', screenshot.toPNG());
    console.error('PASS: real Settings persistence/remount, invalid rejection, mode fallback; runtime completed/partial/failed/cancelled and estimated/reserved UI.');
    await fs.writeFile('/tmp/phase4-ui-results.json', JSON.stringify({ settings: results.settings,
      cases: Object.fromEntries(Object.entries(cases).map(([name,value])=>[name,{status:value.transcript.status,
        stopReason:value.transcript.stopReason,accounting:value.transcript.accounting,compactions:value.transcript.compactions}])) },null,2));
  } finally {
    dispose?.(); window?.destroy(); database.closeDatabase(); await fs.rm(directory, { recursive: true, force: true });
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
