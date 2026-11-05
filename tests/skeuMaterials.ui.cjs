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
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'continuum-skeu-'));
  const output = process.env.SKEU_REVIEW_DIR || path.join(directory, 'screenshots');
  await fs.mkdir(output, { recursive: true });
  const assets = path.resolve('dist/assets');
  const css = (await fs.readdir(assets)).find(name => name.endsWith('.css'));
  const html = await fs.readFile('index.html', 'utf8');
  const csp = html.match(/content="(default-src[^"]+)"/)[1];
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const reviewThemes = process.env.SKEU_REVIEW_THEMES?.split(',') || ['ember-dark', 'gruvbox-dark', 'light', 'lilac'];
  const report = [];
  const material = selector => page.locator(selector).first().evaluate(element => {
    const s = getComputedStyle(element), p = getComputedStyle(element, '::before');
    return { fill: s.backgroundColor, image: s.backgroundImage, blur: s.backdropFilter, radius: s.borderRadius, shadow: s.boxShadow, texture: p.backgroundImage, textureDisplay: p.display, outline: s.outlineStyle };
  });
  async function load(name, query = "") {
    await esbuild.build({ entryPoints: [path.resolve(`tests/fixtures/${name}.jsx`)], bundle: true, jsx: 'automatic',
      inject: [path.resolve('tests/fixtures/materialScope.mjs')], outfile: path.join(directory, name + '.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, name + '.html'), `<html data-theme="dark"><head><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css)).href}"></head><body style="margin:0;background:var(--bg-secondary)"><div id="root"></div><script src="${name}.js"></script></body></html>`);
    await page.goto(pathToFileURL(path.join(directory, name + '.html')).href + query);
  }
  async function scope(theme, style = 'skeu') {
    await page.evaluate(({ theme, style }) => {
      window.reviewApplyTheme(theme);
      window.reviewSetAppearance(style);
    }, { theme, style });
    await page.waitForTimeout(180);
  }
  async function shot(name) { await page.screenshot({ path: path.join(output, name + '.png') }); }
  async function captures(screen) {
    for (const theme of reviewThemes) for (const style of ['aero', 'skeu']) {
      await scope(theme, style); await shot(`${screen}-${theme}-${style}`);
    }
  }
  try {
    await load('memorySettings');
    await page.waitForSelector('dialog[open]');
    await page.getByRole('radio', { name: 'Skeu Satin & texture' }).check();
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.style), 'skeu');
    assert.equal(await page.evaluate(()=>localStorage.getItem('appearance')), 'skeu');
    await page.reload(); await page.waitForSelector('dialog[open]');
    assert.equal(await page.getByRole('radio', { name: 'Skeu Satin & texture' }).isChecked(), true);
    for (const theme of themes) {
      await scope(theme.id);
      assert.equal(await page.evaluate(()=>document.documentElement.dataset.themeMode), theme.mode);
      const shell = await material('.sk-window');
      const header = await material('.sk-window-header');
      assert.equal(shell.blur, 'none', `${theme.id}: opaque, unfiltered shell`);
      assert.equal(shell.radius, '6px');
      assert.notEqual(shell.image, 'none');
      assert(header.texture.includes('data:image/svg+xml'), `${theme.id}: static grain loads`);
      assert.equal(await page.locator('[role=radiogroup]').first().evaluate(e=>getComputedStyle(e,'::before').backgroundImage), 'none');
      const rows = await page.evaluate(() => {
        const s = getComputedStyle(document.documentElement);
        const canvas = document.createElement('canvas'); canvas.width=canvas.height=1;
        const ctx=canvas.getContext('2d', { willReadFrequently: true });
        const rgb=t=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=s.getPropertyValue(t).trim();ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
        const l=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((n,v,i)=>n+v*[.2126,.7152,.0722][i],0);
        const contrast=(a,b)=>{const x=[l(rgb(a)),l(rgb(b))].sort((a,b)=>b-a);return (x[0]+.05)/(x[1]+.05)};
        return { bodyTop:contrast('--sk-text','--sk-top'), bodyBottom:contrast('--sk-text','--sk-bottom'), accentTop:contrast('--sk-on-accent','--sk-accent-top'), accentBottom:contrast('--sk-on-accent','--sk-accent-bottom'), focus:contrast('--sk-focus','--sk-field') };
      });
      assert(rows.bodyTop >= 4.5 && rows.bodyBottom >= 4.5, `${theme.id}: body text on satin endpoints`);
      assert(rows.accentTop >= 4.5 && rows.accentBottom >= 4.5, `${theme.id}: accent labels ${JSON.stringify(rows)}`);
      assert(rows.focus >= 3, `${theme.id}: focus ring contrast`);
      report.push({ theme: theme.id, mode: theme.mode, ...rows });
    }
    await captures('settings');
    // No texture can survive switching away, even though opt-in hooks remain.
    for (const style of ['aero','flat']) {
      await scope('gruvbox-dark', style);
      assert.equal((await material('.sk-window-header')).texture, 'none');
    }
    await scope('gruvbox-dark');
    await page.locator('[role=radio].sk-choice[aria-checked=true]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme), themes[themes.findIndex(t=>t.id==='gruvbox-dark')+1].id);
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme), themes[0].id);
    await page.locator('#settings-tab-integrations').click();
    await page.waitForSelector('input.sk-switch');
    const server = page.getByRole('switch', { name: 'Enable server terminal' });
    await server.uncheck(); assert.equal(await server.isChecked(), false);
    await server.check(); assert.equal(await server.isChecked(), true);
    await page.locator('article summary').first().click();
    await page.locator('article input.sk-checkbox').first().uncheck();
    assert.equal(await page.locator('article input.sk-checkbox').first().isChecked(), false);
    await captures('integrations');
    // CSP is the application's real policy, not weakened for embedded texture.
    assert(await page.evaluate(async () => {
      const image=getComputedStyle(document.querySelector('.sk-texture-grain'),'::before').backgroundImage;
      const source=image.slice(5,-2); const img=new Image(); img.src=source;
      try { await img.decode(); return img.width===128; } catch { return false; }
    }));
    await load('projects'); await page.waitForSelector('.project-card');
    await captures('projects');
    await scope('gruvbox-dark');
    assert.equal((await material('.project-card')).radius, '6px');
    assert.notEqual((await material('.project-card')).texture, 'none');
    assert.equal(await page.locator('.project-card').evaluate(e=>getComputedStyle(e,'::before').pointerEvents), 'none');
    await page.locator('.project-card').hover();
    assert.equal(await page.locator('.project-card').evaluate(e=>getComputedStyle(e).transform), 'none');
    await page.locator('.project-card-link').click(); await page.waitForSelector('.project-composer');
    await captures('workspace');
    await scope('gruvbox-dark');
    await page.locator('textarea[aria-label="Message"]').focus();
    assert.equal(await page.locator('.project-composer').evaluate(e=>getComputedStyle(e,'::before').backgroundImage), 'none');
    await shot('composer-focus');
    await load('aeroModelSettings'); await page.waitForSelector('fieldset');
    await captures('model');
    await scope('gruvbox-dark');
    const select = page.locator('button[aria-haspopup="listbox"]').first();
    await select.click(); await page.waitForSelector('.sk-menu');
    assert.equal(await page.locator('.sk-menu').first().evaluate(e=>e.closest('dialog')?.open), true);
    assert.equal((await material('.sk-menu')).texture, 'none');
    assert.equal((await material('.sk-menu')).blur, 'none');
    await shot('model-menu'); await page.keyboard.press('Escape');
    const primary = page.getByRole('button', {name:'Load model', exact:true});
    const idleShadow = await primary.evaluate(e=>getComputedStyle(e).boxShadow);
    await primary.hover(); await page.mouse.down();
    assert.notEqual(await primary.evaluate(e=>getComputedStyle(e).boxShadow), idleShadow);
    await shot('model-pressed');
    await page.mouse.move(5,5); await page.mouse.up();
    const input=page.locator('input.sk-checkbox').first();
    await page.keyboard.press('Tab'); await input.focus(); assert.equal(await input.evaluate(e=>getComputedStyle(e).outlineStyle), 'solid');
    await input.evaluate(e=>e.indeterminate=true); await shot('model-indeterminate');
    const number = page.locator('input[type=number]').first();
    const field = number.locator('..');
    const originalBorder = await field.evaluate(e=>getComputedStyle(e).borderColor);
    await number.evaluate(e=>e.setAttribute('aria-invalid','true'));
    assert.notEqual(await field.evaluate(e=>getComputedStyle(e).borderColor), originalBorder);
    await number.evaluate(e=>{e.removeAttribute('aria-invalid');e.readOnly=true});
    await shot('model-readonly');
    await number.evaluate(e=>e.readOnly=false);
    const scroller=page.locator('dialog .overflow-y-auto').first();
    const footerBefore=await page.locator('footer').boundingBox();
    await scroller.evaluate(e=>e.scrollTop=e.scrollHeight);
    assert(await scroller.evaluate(e=>e.scrollTop>0));
    assert.deepEqual(await page.locator('footer').boundingBox(), footerBefore);
    await shot('model-scrolled');
    // Narrow effective viewports exercise reflow at desktop zoom levels.
    for (const [width, height] of [[1280,900],[1024,720],[853,600],[700,740]]) {
      await page.setViewportSize({width,height});
      const footer = await page.locator('footer').boundingBox();
      assert(footer.y>=0 && footer.y+footer.height<=height, 'model actions remain visible');
      await shot(`model-viewport-${width}`);
    }
    await page.setViewportSize({width:1280,height:900});
    await load('aeroModelSettings', '?loading=1');
    await scope('ember-dark');
    await page.getByRole('status').filter({hasText:'Loading saved settings'}).waitFor();
    await shot('model-loading');
    await load('aeroModelSettings', '?error=1'); await scope('ember-dark');
    await page.getByText('Model metadata is unavailable.').waitFor();
    await shot('model-error');
    await load('projects', '?materialStress=1'); await page.waitForSelector('.project-card');
    await scope('gruvbox-dark');
    assert.equal(await page.locator('.project-card').count(), 60);
    await page.getByRole('searchbox', {name:'Search projects'}).fill('no matching project');
    await page.locator('.sk-empty').waitFor(); await shot('projects-empty');
    assert.equal((await material('.sk-empty')).texture, 'none');
    await page.getByRole('searchbox', {name:'Search projects'}).fill('');
    await page.waitForFunction(()=>document.querySelectorAll('.project-card').length===60);
    assert.equal(await page.locator('.project-card').evaluateAll(nodes=>nodes.filter(e=>getComputedStyle(e).backdropFilter !== 'none').length), 0);
    await page.locator('.projects-page').evaluate(e=>e.scrollTop=e.scrollHeight);
    assert(await page.locator('.projects-page').evaluate(e=>e.scrollTop>0));
    await shot('projects-populated');
    await load('aeroChrome'); await page.waitForSelector('.aero-titlebar');
    await captures('chrome');
    await scope('gruvbox-dark');
    assert.equal(await page.locator('.aero-titlebar').evaluate(e=>getComputedStyle(e).getPropertyValue('-webkit-app-region')), 'drag');
    // Textures never nest or cover fields; explicit opt-out and environment modes.
    assert.equal(await page.locator('.sk-texture-grain .sk-texture-grain, .sk-texture-brushed .sk-texture-grain').count(), 0);
    await page.evaluate(()=>document.documentElement.dataset.texture='off');
    assert.equal((await material('.aero-titlebar')).textureDisplay, 'none');
    await shot('texture-off');
    await page.evaluate(()=>delete document.documentElement.dataset.texture);
    await page.emulateMedia({forcedColors:'active'});
    assert.equal((await material('.aero-titlebar')).textureDisplay, 'none');
    assert.equal((await material('.aero-titlebar')).image, 'none');
    await page.emulateMedia({forcedColors:'none',media:'print'});
    assert.equal((await material('.aero-titlebar')).textureDisplay, 'none');
    await page.emulateMedia({media:'screen',reducedMotion:'reduce'});
    assert.equal(await page.locator('.sk-icon-button').first().evaluate(e=>getComputedStyle(e).transitionDuration), '0s');
    await page.emulateMedia({reducedMotion:'no-preference'});
    for (const scale of [1,1.25,1.5,2]) {
      await page.evaluate(scale=>document.body.style.zoom=String(scale),scale);
      await shot(`texture-scale-${scale}`);
    }
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(output,'theme-audit.json'),JSON.stringify(report,null,2));
    console.log(`Skeu: ${themes.length} themes, preference restore/sync, radio keys, switches/checkboxes, portals, texture CSP/isolation/opt-out, scrolling and fallbacks passed. Captures: ${output}`);
  } finally { await browser.close(); if(process.env.SKEU_REVIEW_DIR) await fs.rm(directory,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1});
