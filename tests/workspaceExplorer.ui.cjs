// Run with: env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/workspaceExplorer.ui.cjs
if (!process.versions.electron) {
  require('node:test')('workspace explorer UI requires Electron', t => t.skip());
} else {
  const { app, BrowserWindow } = require('electron');
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  app.disableHardwareAcceleration();
  app.on('window-all-closed', event => event.preventDefault());
  app.whenReady().then(async () => {
    const directory = await fs.mkdtemp('/tmp/workspace-explorer-ui-');
    const window = new BrowserWindow({ show: true, width: 1440, height: 900, webPreferences: { sandbox: true } });
    try {
      await require('esbuild').build({ stdin: { contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import Sidebar from './src/components/Sidebar.jsx';
        import ResizableSidebar from './src/components/ResizableSidebar.jsx';
        import { WorkspaceSplit, WorkspaceFilePreview } from './src/components/WorkspaceFiles.jsx';
        window.explorerTimers = new Set();
        const nativeSetInterval = window.setInterval.bind(window);
        const nativeClearInterval = window.clearInterval.bind(window);
        window.setInterval = (fn, ms, ...args) => { const id = nativeSetInterval(fn, ms, ...args); if (ms === 10000) window.explorerTimers.add(id); return id; };
        window.clearInterval = id => { window.explorerTimers.delete(id); nativeClearInterval(id); };
        window.gitConnected = true;
        window.isRepository = true;
        window.api = {
          getWorkspaceRepository: async () => ({ available: window.isRepository }),
          getRecoveryChangedFiles: async () => { await new Promise(resolve => setTimeout(resolve, 250)); return { files: [{path:'src/app.js',status:'modified',added:1,deleted:1}], branch:'main' }; },
          getRecoveryFileDiff: async () => ({ text: ['@@ -10000,100 +10000,100 @@', ...Array.from({length:100}, (_, i) => ['-const answer = 41; // ' + 'original '.repeat(40), '+const answer = 42; // ' + 'updated '.repeat(40)]).flat()].join(String.fromCharCode(10)) }),
          getRecoveryCoveringCheckpoint: async () => null,
          getWorkspaceGitStatus: async () => ({ connected: window.gitConnected, modified: ['README.md'] }),
          listWorkspaceDirectory: async (id, path) => ({ items: path === '.' ? [{name:'src',path:'src',directory:true},{name:'README.md',path:'README.md'}] : [{name:'app.js',path:'src/app.js'}] }),
          readWorkspaceFile: async (id, path) => ({ content: window.largePreview ? 'a'.repeat(100000) : path === 'README.md' ? '# Project documentation' : 'export function AttachmentControls({ attachment, sessionId = attachment.session_id, disabled = false, onChange, expanded = false }) { return <div className="long-preview-content" data-description="' + 'long JSX content '.repeat(35) + '">{attachment.name}</div>; }' }),
        };
        function Demo() {
          const [file, setFile] = useState(null);
          const [workspace, setWorkspace] = useState(true);
          const [explorerActive, setExplorerActive] = useState(true);
          window.setExplorerActive = setExplorerActive;
          window.setWorkspace = setWorkspace;
          return <div style={{display:'flex', height:'100vh', color:'var(--text-primary)', background:'var(--bg-primary)'}}>
            <ResizableSidebar open><Sidebar explorerActive={explorerActive} isWorkspace={workspace} chatProjectId="project" projects={[{id:'project',name:'Example workspace'}]} groups={[]} onSelectFile={setFile} selectedFilePath={file} /></ResizableSidebar>
            <WorkspaceSplit preview={file && <WorkspaceFilePreview projectId="project" sessionId="chat" path={file} onClose={() => setFile(null)} />}>
              <div data-chat style={{flex:1,padding:24}}><h2>Main chat</h2><p>Chat stays visible while browsing workspace files.</p><textarea aria-label="Message" defaultValue="Keep my draft" /></div>
            </WorkspaceSplit>
          </div>;
        }
        createRoot(document.getElementById('root')).render(<Demo />);
      `, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, outfile: path.join(directory, 'app.js'), loader: { '.css': 'empty' } });
      const cssFiles = (await fs.readdir(path.join(process.cwd(), 'dist/assets'))).filter(file => /\.css$/.test(file));
      await fs.writeFile(path.join(directory, 'style.css'), (await Promise.all(cssFiles.map(file => fs.readFile(path.join(process.cwd(), 'dist/assets', file), 'utf8')))).join('\n'));
      await fs.writeFile(path.join(directory, 'index.html'), '<html><head><link rel="stylesheet" href="style.css"></head><body style="margin:0"><div id="root"></div><script src="app.js"></script></body></html>');
      await window.loadFile(path.join(directory, 'index.html'));
      const result = await window.webContents.executeJavaScript(`(async () => {
        const wait = () => new Promise(resolve => setTimeout(resolve, 80));
        const button = text => [...document.querySelectorAll('button')].find(b => (b.querySelector('span.truncate')?.textContent || b.textContent).trim() === text);
        const check = (ok, message) => { if (!ok) throw new Error(message); };
        await wait();
        const sidebar = document.querySelector('#chat-sidebar');
        const resizeSidebar = () => document.querySelector('[aria-label="Resize left sidebar"]').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}));
        const initialWidth = sidebar.getBoundingClientRect().width;
        resizeSidebar(); await wait(); check(sidebar.getBoundingClientRect().width === initialWidth + 16, 'workspace sidebar resizes');
        check(getComputedStyle(sidebar.querySelector('aside')).borderRightWidth === '1px', 'workspace sidebar border');
        window.setWorkspace(false); await wait();
        const workspaceWidth = sidebar.getBoundingClientRect().width;
        resizeSidebar(); await wait(); check(sidebar.getBoundingClientRect().width === workspaceWidth + 16, 'casual sidebar resizes');
        check(getComputedStyle(sidebar.querySelector('aside')).borderRightWidth === '1px', 'casual sidebar border');
        window.setWorkspace(true); await wait(); button('Files').click(); await wait();
        check(button('README.md'), 'root file listed');
        check(window.explorerTimers.size === 1, 'one explorer poll timer');
        for (let i = 0; i < 5; i++) {
          window.setExplorerActive(false); await wait(); check(window.explorerTimers.size === 0, 'hidden explorer has no poll timer');
          window.setExplorerActive(true); await wait(); check(window.explorerTimers.size === 1, 'poll timer does not accumulate');
        }

        check(button('README.md').querySelector('[aria-label="Modified"]')?.textContent === 'M', 'modified badge before filename');
        window.gitConnected = false; document.querySelector('[aria-label="Refresh files"]').click(); await wait();
        check(!document.querySelector('[aria-label="Modified"]'), 'no decoration without GitHub remote');
        window.gitConnected = true; document.querySelector('[aria-label="Refresh files"]').click(); await wait();
        button('src').click(); await wait(); button('app.js').click(); await wait();
        check(document.querySelector('[aria-label="File preview"]').textContent.includes('export function AttachmentControls'), 'nested file preview');
        check(document.querySelector('[data-chat]').getBoundingClientRect().width > 300, 'chat retains width');
        check(document.querySelector('[aria-label="File preview"]').getBoundingClientRect().right < document.querySelector('[data-chat]').getBoundingClientRect().left, 'preview sits left of chat');
        check(document.querySelector('[aria-label="File preview"] code span[style*="--code-keyword"]'), 'JavaScript keywords highlighted');
        check(document.querySelector('[aria-label="Message"]').value === 'Keep my draft', 'draft preserved');
        const preview = document.querySelector('[aria-label="File preview"]');
        preview.style.setProperty('--text-primary', 'rgb(12, 34, 56)');
        preview.style.setProperty('--text-muted', 'rgb(65, 43, 21)');
        check(getComputedStyle(preview.querySelector('header span[title]')).color === 'rgb(12, 34, 56)', 'file title follows theme');
        check(getComputedStyle(preview.querySelector('[aria-label="Refresh preview"]')).color === 'rgb(12, 34, 56)', 'refresh follows theme');
        check(!preview.textContent.includes('Read only'), 'read only label removed');
        document.querySelector('[aria-label="Toggle line wrap"]').click(); await wait();
        check(getComputedStyle(preview.querySelector('code')).whiteSpace === 'pre-wrap', 'file wrap enabled');
        const sourceLine = preview.querySelector('[data-source-line]');
        check(sourceLine && getComputedStyle(sourceLine).display === 'block', 'tokens flow inline within each source line');
        check(sourceLine.getBoundingClientRect().height > 48, 'long JSX line wraps across rows');
        const fileViewport = preview.querySelector('code').closest('pre').parentElement;
        check(fileViewport.scrollWidth <= fileViewport.clientWidth + 1, 'wrapped JSX fits preview width');
        check(sourceLine.querySelectorAll('.react-syntax-highlighter-line-number').length === 1, 'one line number per logical source line');

        document.querySelector('[aria-label="Toggle line wrap"]').click(); await wait();
        preview.style.removeProperty('--text-primary'); preview.style.removeProperty('--text-muted');
        button('Git diff').click(); await wait();
        const loading = document.querySelector('[aria-label="Review workspace changes"] [role="status"]');
        check(loading?.textContent === 'Loading changed files…', 'loading status visible');
        check(getComputedStyle(loading).alignItems === 'center' && getComputedStyle(loading).justifyContent === 'center', 'loading centered on both axes');
        await new Promise(resolve => setTimeout(resolve, 300));
        check(document.querySelector('[aria-label="File diff"]')?.textContent.includes('answer'), 'embedded file diff renders');
        check(!document.querySelector('dialog'), 'diff opens inline');
        check(document.querySelector('[aria-label="Unified code"]'), 'inline diff defaults to unified');
        check(getComputedStyle(document.querySelector('[aria-label="Revert controls"]')).display === 'none', 'recovery controls tucked away');
        button('Recovery').click(); await wait();
        check(getComputedStyle(document.querySelector('[aria-label="Revert controls"]')).display !== 'none', 'recovery controls accessible');
        button('Recovery').click(); await wait();
        button('Side-by-side').click(); await wait();
        document.querySelector('[aria-label="Toggle line wrap"]').click(); await wait();
        const wrappedRows = document.querySelectorAll('[aria-label="Original code"] [data-diff-row]');
        const peerRows = document.querySelectorAll('[aria-label="Updated code"] [data-diff-row]');
        check([...wrappedRows].every((row,i) => Math.abs(row.getBoundingClientRect().height - peerRows[i].getBoundingClientRect().height) < 1), 'wrapped split rows stay aligned');
        document.querySelector('[aria-label="Toggle line wrap"]').click(); await wait();
        const leftCode = document.querySelector('[aria-label="Original code"]');
        const rightCode = document.querySelector('[aria-label="Updated code"]');
        const gutter = leftCode.querySelector('span[aria-hidden="true"]');
        check(getComputedStyle(gutter).fontSize === '10px', 'compact line numbers');
        check(gutter.clientWidth >= gutter.scrollWidth, 'five digit line numbers fit');
        check(leftCode.scrollHeight > leftCode.clientHeight, 'split code has viewport vertical scrolling');
        leftCode.scrollTop = 180; leftCode.scrollLeft = 90;
        leftCode.dispatchEvent(new Event('scroll')); await wait();
        check(rightCode.scrollTop === 180 && rightCode.scrollLeft === 90, 'left to right scroll sync');
        rightCode.scrollTop = 320; rightCode.scrollLeft = 140;
        rightCode.dispatchEvent(new Event('scroll')); await wait();
        check(leftCode.scrollTop === 320 && leftCode.scrollLeft === 140, 'right to left scroll sync');
        button('Unified').click(); await wait();
        const unifiedCode = document.querySelector('[aria-label="Unified code"]');
        check(unifiedCode.scrollHeight > unifiedCode.clientHeight && unifiedCode.scrollWidth > unifiedCode.clientWidth, 'unified viewport owns both scroll axes');
        check(unifiedCode.getBoundingClientRect().bottom <= document.querySelector('[aria-label="File preview"]').getBoundingClientRect().bottom + 1, 'horizontal scrollbar stays at pane bottom');
        button('File').click(); await wait();
        window.largePreview = true; document.querySelector('[aria-label="Refresh preview"]').click(); await wait();
        check(document.querySelector('[aria-label="File preview"]').textContent.includes('Large file:'), 'large file avoids tokenization');
        check(document.querySelectorAll('[aria-label="File preview"] code span').length === 0, 'large preview has bounded markup');
        window.largePreview = false; window.isRepository = false; document.querySelector('[aria-label="Refresh preview"]').click(); await wait();
        check(!button('Git diff') && !document.querySelector('[aria-label="Preview mode"]'), 'non repository hides Git controls');
        window.isRepository = true; document.querySelector('[aria-label="Refresh preview"]').click(); await wait();
        check(document.querySelector('[aria-label="File preview"] code'), 'switch back to file');
        const divider = document.querySelector('[aria-label="Resize chat and file preview"]');
        check(divider.getAttribute('aria-valuenow') === '40', 'default preview width');
        check(divider.getBoundingClientRect().width === 1, 'thin preview divider');
        check(getComputedStyle(document.querySelector('[aria-label="File preview"] code')).userSelect === 'text', 'preview text selectable');
        divider.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft', bubbles:true})); await wait();
        check(divider.getAttribute('aria-valuenow') === '35', 'divider keyboard resize');
        button('Chats').click(); await wait(); check(document.querySelector('[aria-label="File preview"]'), 'preview survives sidebar switch');
        button('Files').click(); await wait(); button('README.md').click(); await wait();
        check(document.querySelector('[aria-label="File preview"]').textContent.includes('# Project documentation'), 'switch preview');
        return true;
      })()`);
      assert.equal(result, true);
      const grip = await window.webContents.executeJavaScript(`(() => { const r = document.querySelector('[aria-label="Resize left sidebar"]').getBoundingClientRect(); return {x: Math.round(r.left + r.width / 2), y: 300, width: document.querySelector('#chat-sidebar').clientWidth}; })()`);
      window.focus();
      window.webContents.focus();
      window.webContents.sendInputEvent({type:'mouseMove', x:grip.x, y:grip.y});
      window.webContents.sendInputEvent({type:'mouseDown', x:grip.x, y:grip.y, button:'left', clickCount:1});
      await new Promise(resolve => setTimeout(resolve, 80));
      window.webContents.sendInputEvent({type:'mouseMove', x:grip.x + 60, y:grip.y, movementX:60, movementY:0, modifiers:['leftButtonDown']});
      await new Promise(resolve => setTimeout(resolve, 80));
      window.webContents.sendInputEvent({type:'mouseUp', x:grip.x + 60, y:grip.y, button:'left', clickCount:1});
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(await window.webContents.executeJavaScript(`document.querySelector('#chat-sidebar').clientWidth > ${grip.width + 40}`), 'sidebar expands by dragging its edge: ' + await window.webContents.executeJavaScript(`document.querySelector('#chat-sidebar').clientWidth`));
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});
      window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
      await window.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('[aria-label="Refresh preview"]');
        button.style.setProperty('--accent', 'rgb(11, 122, 133)');
        button.style.setProperty('--ui-radius-control', '9px');
        button.focus();
        const style = getComputedStyle(button);
        if (!button.matches(':focus-visible') || style.outlineColor !== 'rgb(11, 122, 133)' || style.borderRadius !== '9px') throw new Error('Theme focus color and dynamic radius');
        button.style.borderRadius = '50%';
        if (getComputedStyle(button).borderRadius !== '50%') throw new Error('Circular focus shape preserved');
        button.blur(); button.style.removeProperty('--accent'); button.style.removeProperty('--ui-radius-control'); button.style.removeProperty('border-radius');
      })()`);
      await new Promise(resolve => setTimeout(resolve, 250));
      await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Git diff').click()`);
      await new Promise(resolve => setTimeout(resolve, 350));
      await fs.writeFile('/tmp/workspace-explorer-preview.png', (await window.webContents.capturePage()).toPNG());
      assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Close file preview"]').click(); true`), true);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(await window.webContents.executeJavaScript(`!document.querySelector('[aria-label="File preview"]') && document.querySelector('[aria-label="Message"]').value === 'Keep my draft'`), true);
      console.log('Workspace sidebar, folders, split preview, resize, draft preservation and close passed.');
    } finally { window.destroy(); await fs.rm(directory, {recursive:true,force:true}); }
  }).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
}
