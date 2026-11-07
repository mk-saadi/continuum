// env -u ELECTRON_RUN_AS_NODE xvfb-run -a node_modules/electron/dist/electron --no-sandbox tests/videoPlayback.ui.cjs
const { app, BrowserWindow, protocol } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const { serveMediaRequest } = require('../src/main/localMedia');
protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'video-playback-'));
  const browser = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  const requests = [];
  try {
    const files = [path.join(directory, 'tail metadata #%.mp4'), path.join(directory, 'clip.webm')];
    for (const file of files) execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=24', '-t', '5',
      '-c:v', file.endsWith('.mp4') ? 'libx264' : 'libvpx-vp9', '-threads', '2', file]);
    protocol.handle('media', async request => {
      const response = await serveMediaRequest(request, file => file.startsWith(directory + path.sep));
      requests.push({ range: request.headers.get('range'), status: response.status });
      return response;
    });
    await esbuild.build({ stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import ChatMessage, { ProgressText } from './src/components/ChatMessage';
      const root = createRoot(document.getElementById('root'));
      const content = ${JSON.stringify(`![Video](<${files[0]}>)`)};
      window.updateChat = (busy = false, append = false) => root.render(<>
        <ChatMessage message={{ id: 1, role: 'assistant', content, created_at: busy ? 'new metadata' : 'old metadata' }}
          disabled={busy} pendingQuestions={{}} />
        <ProgressText text={${JSON.stringify(`![Video](<${files[1]}>)`)}} />
        {append && <ChatMessage message={{ id: 2, role: 'assistant', content: 'New response' }} />}
      </>);
      window.updateChat();
    `, loader: 'jsx', resolveDir: process.cwd() }, bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const source = await fs.readFile('index.html', 'utf8');
    const csp = source.match(/content="(default-src[^"]+)"/)[1];
    await fs.writeFile(path.join(directory, 'index.html'), `<meta http-equiv="Content-Security-Policy" content="${csp}"><div id="root"></div><script src="fixture.js"></script>`);
    await browser.loadFile(path.join(directory, 'index.html'));
    await browser.webContents.executeJavaScript(`(async () => {
      const waitFor = async (predicate, label) => {
        for (let i = 0; i < 200; i++) {
          if (document.querySelector('[role="status"]')) throw new Error(document.querySelector('[role="status"]').textContent);
          if (predicate()) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Timed out: ' + label);
      };
      await waitFor(() => document.querySelectorAll('video').length === 2, 'render');
      const videos = [...document.querySelectorAll('video')];
      // Preload the entire group before playing, matching a chat with many embeds.
      await waitFor(() => videos.every(video => video.readyState >= 1), 'metadata preload');
      await new Promise(resolve => setTimeout(resolve, 500));
      let loads = 0;
      videos.forEach(video => video.addEventListener('loadstart', () => loads++));
      window.updateChat(true, true);
      await new Promise(resolve => setTimeout(resolve, 150));
      window.updateChat(false, true);
      await new Promise(resolve => setTimeout(resolve, 150));
      if (videos.some((video, index) => video !== document.querySelectorAll('video')[index]))
        throw new Error('Existing media was remounted after a chat update');
      if (loads) throw new Error('Existing media reloaded after a chat update');
      for (const video of videos) {
        video.muted = true;
        await video.play();
        await waitFor(() => video.currentTime > 0.3 && video.readyState >= 2, 'playback');
        const before = video.currentTime;
        video.volume = 0.37;
        window.updateChat(true, true);
        await new Promise(resolve => setTimeout(resolve, 150));
        window.updateChat(false, true);
        await new Promise(resolve => setTimeout(resolve, 150));
        if (!video.isConnected || video.paused || video.currentTime < before || video.volume !== 0.37)
          throw new Error('Chat update reset playback or user volume');
        if (loads) throw new Error('Chat update restarted media loading');
        video.currentTime = 3;
        await waitFor(() => video.currentTime > 3.3 && !video.seeking && video.readyState >= 2, 'seek and resume');
        video.pause();
      }
    })()`);
    assert.ok(requests.some(request => /^bytes=[1-9]/.test(request.range)), 'Browser requests nonzero byte ranges');
    assert.ok(requests.every(request => request.status === 206), JSON.stringify(requests));
    console.log('Chat media identity across updates, MP4/WebM preload, playback, seeking, and resuming passed.');
  } finally {
    browser.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
}).then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
