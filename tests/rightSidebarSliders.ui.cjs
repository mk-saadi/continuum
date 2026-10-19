const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidebar-sliders-ui-'));
  const window = new BrowserWindow({ show: true, width: 800, height: 1200, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures/rightSidebarSliders.jsx')], bundle: true, outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const assets = path.join(__dirname, '../dist/assets');
    const css = (await fs.readdir(assets)).find(file => file.endsWith('.css'));
    await fs.copyFile(path.join(assets, css), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await new Promise(resolve => setTimeout(resolve, 200));
    await window.webContents.executeJavaScript(`document.getElementById('controls-tab-generation').click()`);
    await new Promise(resolve => setTimeout(resolve, 200));
    const send = async event => { window.webContents.sendInputEvent(event); await new Promise(resolve => setTimeout(resolve, 40)); };
    for (const label of ['Temperature', 'Top-P', 'Repeat Penalty']) {
      const slider = await window.webContents.executeJavaScript(`(() => {
        const label = [...document.querySelectorAll('label')].find(el => el.textContent.includes(${JSON.stringify(label)}));
        const input = document.getElementById(label.htmlFor); input.scrollIntoView({ block: 'center' });
        window.draggedInput = input; const r = input.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, min: Number(input.min), max: Number(input.max), value: Number(input.value), id: input.id };
      })()`);
      const sy = Math.round(slider.y + slider.height / 2);
      const sx = fraction => Math.round(slider.x + 8 + (slider.width - 16) * fraction);
      const before = await window.webContents.executeJavaScript('window.commits.length');
      await send({ type: 'mouseMove', x: sx((slider.value - slider.min) / (slider.max - slider.min)), y: sy });
      await send({ type: 'mouseDown', button: 'left', clickCount: 1, x: sx((slider.value - slider.min) / (slider.max - slider.min)), y: sy });
      await send({ type: 'mouseMove', x: sx(.9), y: sy, modifiers: ['leftButtonDown'] });
      const high = await window.webContents.executeJavaScript(`Number(document.getElementById(${JSON.stringify(slider.id)}).value)`);
      assert.ok(high > slider.min + (slider.max - slider.min) * .7, label + ' follows drag right');
      await send({ type: 'mouseMove', x: sx(.2), y: sy, modifiers: ['leftButtonDown'] });
      const low = await window.webContents.executeJavaScript(`Number(document.getElementById(${JSON.stringify(slider.id)}).value)`);
      assert.ok(low < slider.min + (slider.max - slider.min) * .4, label + ' follows drag left');
      assert.equal(await window.webContents.executeJavaScript('window.commits.length'), before, 'No save interrupts drag');
      await send({ type: 'mouseUp', button: 'left', clickCount: 1, x: sx(.2), y: sy });
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(await window.webContents.executeJavaScript('window.commits.length'), before + 1, 'One save on release');
      await window.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(slider.id)}).focus()`);
      assert.ok(await window.webContents.executeJavaScript('window.draggedInput.isConnected'), 'Save must not remount the slider');
      await send({ type: 'keyDown', keyCode: 'Right' });
      await send({ type: 'keyUp', keyCode: 'Right' });
      await new Promise(resolve => setTimeout(resolve, 150));
      assert.equal(await window.webContents.executeJavaScript('window.commits.length'), before + 2, 'Keyboard changes save');
    }
    console.log('Right sidebar sliders retain their DOM nodes, drag continuously, save on release, and support keyboard input.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
