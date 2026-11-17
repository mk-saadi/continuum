// Build first. CHROME_PATH optionally selects an installed Chromium executable.
// Tests changed behavior using real components and deterministic mock IPC.
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
(async () => {
  const { themes } = await import('../src/lib/themes.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'continuum-neumorphism-'));
  const output = process.env.NEU_REVIEW_DIR || path.join(directory, 'screenshots');
  await fs.mkdir(output, { recursive: true });
  const assets = path.resolve('dist/assets');
  const css = (await fs.readdir(assets)).filter(name => /^(index|App)-.*\.css$/.test(name)).sort().reverse();
  const html = await fs.readFile('index.html', 'utf8');
  const csp = html.match(/content="(default-src[^"]+)"/)[1];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const material = selector => page.locator(selector).first().evaluate(element => {
    const s = getComputedStyle(element), p = getComputedStyle(element, '::before');
    return { fill: s.backgroundColor, image: s.backgroundImage, blur: s.backdropFilter, radius: s.borderRadius, shadow: s.boxShadow, texture: p.backgroundImage, textureDisplay: p.display, outline: s.outlineStyle };
  });
  async function load(name, query = "") {
    let source = await fs.readFile(`tests/fixtures/${name}.jsx`, 'utf8');
    if (name === 'projects') source = source.replace(/<Sidebar[\s\S]*?\/>/, '');
    const wrapped = source.includes("import { ToastProvider }") ? source : `import { ToastProvider } from 'react-toast-master';\n` + source.replace(/\.render\(([\s\S]*?)\);/, '.render(<ToastProvider>$1</ToastProvider>);');
    await esbuild.build({ stdin: { contents: wrapped, loader: 'jsx', resolveDir: path.resolve('tests/fixtures') }, bundle: true, jsx: 'automatic',
      inject: [path.resolve('tests/fixtures/materialScope.mjs')], outfile: path.join(directory, name + '.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, name + '.html'), `<html data-theme="dark"><head><meta http-equiv="Content-Security-Policy" content="${csp}">${css.map(name => `<link rel="stylesheet" href="${pathToFileURL(path.join(assets, name)).href}">`).join('')}</head><body style="margin:0;background:var(--neu-material, var(--bg-secondary));color:var(--text-primary)"><div id="root"></div><script src="${name}.js"></script></body></html>`);
    await page.goto(pathToFileURL(path.join(directory, name + '.html')).href + query);
  }
  async function scope(theme, style = 'neumorphism') {
    await page.evaluate(({theme, style}) => { window.reviewApplyTheme(theme); window.reviewSetAppearance(style); }, {theme, style});
  }
  const audit = [];
  try {
    await load('memorySettings');
    await page.waitForSelector('dialog[open]');
    for (const theme of themes) {
      await scope(theme.id);
      const shell = await material('.material-dialog');
      assert.equal(shell.blur, 'none'); assert.equal(shell.image, 'none');
      assert.equal(shell.radius, '24px'); assert.notEqual(shell.shadow, 'none');
      assert(!shell.shadow.includes('NaN'));
      const borders = await page.locator('.material-dialog, .material-panel, .material-control, .material-well').evaluateAll(nodes => nodes.filter(e => {
        const s = getComputedStyle(e);
        return s.borderTopStyle !== 'none' && parseFloat(s.borderTopWidth) > 0 && s.borderTopColor !== 'rgba(0, 0, 0, 0)';
      }).map(e=>e.className));
      assert.deepEqual(borders, [], `${theme.id}: decorative borders`);
      const dividers = await page.locator('.material-dialog .material-header, .material-dialog .material-navigation').evaluateAll(nodes => nodes.every(e => {
        const s = getComputedStyle(e);
        return ['Bottom', 'Right'].some(edge => parseFloat(s[`border${edge}Width`]) > 0 && s[`border${edge}Color`] !== 'rgba(0, 0, 0, 0)');
      }));
      assert(dividers, `${theme.id}: structural dividers remain visible`);
      const selectedShadow = await page.locator('.material-style-choice[data-selected="true"]').evaluate(e=>getComputedStyle(e).boxShadow);
      assert(selectedShadow.includes('1px 1px 3px'), 'small selected controls use shallow relief');
      const contrast = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const canvas = document.createElement('canvas'); canvas.width=canvas.height=1;
        const ctx = canvas.getContext('2d');
        const luminance = token => {
          // Resolve color-mix through a real property before asking canvas for RGB.
          const probe = document.createElement('span'); probe.style.color=`var(${token})`; document.body.append(probe);
          ctx.fillStyle=getComputedStyle(probe).color; ctx.fillRect(0,0,1,1); probe.remove();
          const channels=[...ctx.getImageData(0,0,1,1).data].slice(0,3).map(c=>{c/=255;return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;});
          return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722;
        };
        const bg=luminance('--neu-material');
        const ratio=token=>{const fg=luminance(token);return (Math.max(bg,fg)+.05)/(Math.min(bg,fg)+.05);};
        return {primary:ratio('--text-primary'),secondary:ratio('--text-secondary')};
      });
      assert(contrast.primary >= 4.5, `${theme.id}: primary contrast ${contrast.primary}`);
      audit.push({theme:theme.id,...contrast});
    }
    for (const fixture of ['memorySettings', 'materialModelSettings', 'neumorphicModels', 'projects', 'neumorphicTasks', 'materialChrome', 'rightSidebarSliders', 'attachmentComposer', 'chatHistory']) {
      console.log('Review:', fixture); await load(fixture); await page.waitForTimeout(600);
      for (const theme of ['gruvbox-dark','gruvbox','dark','light','lilac']) {
        await scope(theme); await page.waitForTimeout(150);
        if (fixture === 'chatHistory') {
          const sameSurface = await page.locator('.chat-history').evaluate(e => {
            const probe = document.createElement('div');
            probe.style.backgroundColor = 'var(--neu-material)';
            document.body.append(probe);
            const matches = getComputedStyle(e).backgroundColor === getComputedStyle(probe).backgroundColor;
            probe.remove();
            return matches;
          });
          assert(sameSurface, `${theme}: history shares the app material`);
        }
        await page.screenshot({path:path.join(output, `${fixture}-${theme}.png`)});
      }
      if (fixture === 'neumorphicModels') {
        assert(await page.locator('.model-selector-row').evaluateAll(rows => rows.length > 0 && rows.every(row => getComputedStyle(row).overflow === 'visible')), 'model row wrappers do not clip shadows');
        const footer = await page.locator('footer').evaluate(e => { const s = getComputedStyle(e); return parseFloat(s.borderTopWidth) > 0 && s.borderTopColor !== 'rgba(0, 0, 0, 0)'; });
        assert(footer, 'model footer has a top divider');
        await page.locator('button[aria-haspopup="listbox"]').first().click();
        const menu = page.locator('.select-field-menu');
        await menu.waitFor();
        assert(await menu.evaluate(e => { const s = getComputedStyle(e); return parseFloat(s.borderTopWidth) > 0 && s.borderTopColor !== 'rgba(0, 0, 0, 0)'; }), 'SelectField dropdown has a visible soft boundary');
        await page.screenshot({path:path.join(output, 'model-select-dropdown.png')});
        await page.keyboard.press('Escape');
      }
      if (fixture === 'projects') {
        await page.waitForSelector('.project-card');
        const primary = page.locator('.material-primary').first();
        const idle = await primary.evaluate(e=>getComputedStyle(e).backgroundColor);
        await primary.hover(); await page.waitForTimeout(180);
        assert.equal(await primary.evaluate(e=>getComputedStyle(e).backgroundColor),idle, 'primary hover keeps shared material');
      }
      if (['memorySettings','neumorphicModels'].includes(fixture)) {
        for (const width of [700,400]) {
          await page.setViewportSize({width,height:740});
          const bounds = await page.locator('dialog[open]').boundingBox();
          assert(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
          assert(bounds.y >= 0 && bounds.y + bounds.height <= 741);
          await page.screenshot({path:path.join(output, `${fixture}-responsive-${width}.png`)});
        }
        await page.setViewportSize({width:1280,height:900});
      }
      if (fixture === 'attachmentComposer') {
        await page.getByRole('button', {name:'Agent Run Settings', exact:true}).click();
        await page.screenshot({path:path.join(output, 'composer-popover.png')});
      }
      if (fixture === 'memorySettings') {
        await page.locator('#settings-tab-models').click();
        await page.screenshot({path:path.join(output, 'settings-models.png')});
      }
      if (fixture === 'neumorphicModels') {
        for (const action of await page.locator('button.absolute').all()) {
          const initial = await action.boundingBox();
          assert.equal(await action.evaluate(e=>getComputedStyle(e).position),'absolute');
          await action.hover({timeout:3000}); await page.mouse.down();
          assert.deepEqual(await action.boundingBox(), initial);
          await page.mouse.move(640,100); await page.mouse.up();
        }
      }
      for (const style of ['flat','skeu']) {
        await scope('dark', style);
        await page.screenshot({path:path.join(output, `${fixture}-${style}.png`)});
      }
    }
    await load('chatPagination'); await scope('dark');
    await page.evaluate(() => window.renderScenario({key:'neu',sessionId:'review',messages:Array.from({length:35}, (_, i) => ({id:i+1,role:i%2?'assistant':'user',content:('Readable transcript '+i+' ').repeat(50)}))}));
    await page.waitForSelector('[data-transcript-list]');
    await page.waitForTimeout(300);
    await page.locator('[data-transcript-list]').evaluate(e => {e.parentElement.scrollTop = 0; e.parentElement.dispatchEvent(new Event('scroll'));});
    const scroll = page.getByRole('button', {name:'Scroll to bottom', exact:true});
    await scroll.waitFor();
    const bounds = await scroll.boundingBox();
    assert.equal(await scroll.evaluate(e=>getComputedStyle(e).position), 'absolute');
    await scroll.hover(); await page.mouse.down();
    assert.deepEqual(await scroll.boundingBox(),bounds);
    await page.screenshot({path:path.join(output,'chat-scroll-control.png')});
    await page.mouse.move(640,100); await page.mouse.up();
    await load('materialModelSettings'); await page.waitForSelector('fieldset'); await scope('dark');
    for (const width of [700, 400]) {
      await page.setViewportSize({width,height:740});
      const footer = await page.locator('footer.material-footer').boundingBox();
      assert(footer.y >= 0 && footer.y + footer.height <= 741);
      await page.screenshot({path:path.join(output, `responsive-${width}.png`)});
    }
    await page.emulateMedia({forcedColors:'active'});
    assert.equal((await material('.material-dialog')).shadow, 'none');
    await page.emulateMedia({forcedColors:'none', reducedMotion:'reduce'});
    assert.equal(await page.locator('.material-primary').first().evaluate(e=>getComputedStyle(e).transitionDuration),'0s');
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(output,'theme-audit.json'),JSON.stringify(audit,null,2));
    console.log(`Neumorphism: ${themes.length} themes, component screenshots, positioned actions, responsive footer, forced colors and reduced motion passed. ${output}`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
