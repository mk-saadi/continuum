// Run after npm run build: node tests/aeroMaterials.ui.cjs
// Uses real components with deterministic IPC fixtures; never launches inference.
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'continuum-aero-'));
  const output = process.env.AERO_REVIEW_DIR || path.join(directory, 'screenshots');
  await fs.mkdir(output, { recursive: true });
  const assets = path.resolve('dist/assets');
  const css = (await fs.readdir(assets)).find(name => name.endsWith('.css'));
  const themeSource = await fs.readFile('src/index.css', 'utf8');
  const themes = [...new Set([...themeSource.matchAll(/^\[data-theme="([^"]+)"\] \{/gm)].map(match => match[1]))];
  assert.equal(themes.length, 22);
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const material = selector => page.locator(selector).first().evaluate(element => {
    const s = getComputedStyle(element);
    return { fill: s.backgroundColor, image: s.backgroundImage, blur: s.backdropFilter, shadow: s.boxShadow, color: s.color, outline: s.outlineStyle, transform: s.transform };
  });
  async function load(name) {
    await esbuild.build({ entryPoints: [path.resolve(`tests/fixtures/${name}.jsx`)], bundle: true, jsx: "automatic",
      outfile: path.join(directory, name + '.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    await fs.writeFile(path.join(directory, name + '.html'), `<html data-theme="dark" data-appearance="aero"><head><link rel="stylesheet" href="${pathToFileURL(path.join(assets, css)).href}"></head><body style="margin:0;background:var(--bg-secondary)"><div aria-hidden="true" style="position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse at 15% 10%,color-mix(in srgb,var(--accent) 28%,transparent),transparent 50%)"></div><div id="root"></div><script>localStorage.setItem('appearance','aero')</script><script src="${name}.js"></script></body></html>`);
    await page.goto(pathToFileURL(path.join(directory, name + '.html')).href);
  }
  async function appearance(theme, style) {
    await page.evaluate(({ theme, style }) => {
      document.documentElement.dataset.theme = theme;
      window.setFixtureTheme?.(theme);
      document.documentElement.dataset.appearance = style;
    }, { theme, style });
    await page.waitForTimeout(200);
  }
  async function shot(name) { await page.screenshot({ path: path.join(output, name + '.png') }); }
  const reviewThemes = ['gruvbox-dark', 'dark', 'light', 'lilac'];
  const report = [];
  try {
    await load('aeroChrome');
    await page.waitForSelector('.aero-titlebar');
    for (const theme of reviewThemes) for (const style of ['aero', 'flat']) {
      await appearance(theme, style);
      assert.equal((await material('.aero-titlebar')).blur === 'none', style === 'flat');
      assert.equal(await page.locator('.aero-titlebar').evaluate(e=>getComputedStyle(e).getPropertyValue('-webkit-app-region')), 'drag');
      await shot(`chrome-${theme}-${style}`);
    }
    await load('memorySettings');
    await page.waitForSelector('dialog[open]');
    for (const theme of themes) for (const style of ['aero', 'flat']) {
      await appearance(theme, style);
      const shell = await material('.aero-dialog');
      const panel = await material('.appearance-settings .aero-panel');
      assert.notEqual(shell.fill, 'rgba(0, 0, 0, 0)', `${theme}: shell fill resolves`);
      assert.notEqual(panel.fill, 'rgba(0, 0, 0, 0)', `${theme}: panel fill resolves`);
      assert.equal(panel.blur, 'none', `${theme}: cards have no blur layer`);
      assert.equal(panel.image.includes('48%'), false, `${theme}: content has no repeated control stripe`);
      assert.equal(shell.blur === 'none', style === 'flat', `${theme}: appearance controls shell blur`);
      const childrenBlurred = await page.locator('.aero-dialog [class*="aero-"]').evaluateAll(nodes => nodes.filter(n => getComputedStyle(n).backdropFilter !== 'none').length);
      assert.equal(childrenBlurred, 0, `${theme}: a dialog supplies the only blur`);
      const contrast = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const canvas = document.createElement('canvas'); canvas.width=canvas.height=1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const rgb = token => { context.clearRect(0,0,1,1); context.fillStyle=root.getPropertyValue(token).trim(); context.fillRect(0,0,1,1); return [...context.getImageData(0,0,1,1).data].slice(0,3); };
        const luminance = rgb => rgb.map(c=>{c/=255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4}).reduce((sum,c,i)=>sum+c*[0.2126,0.7152,0.0722][i],0);
        const ratio = (a,b) => { const l=[luminance(a),luminance(b)].sort((a,b)=>b-a); return (l[0]+.05)/(l[1]+.05); };
        return { body: ratio(rgb('--text-primary'),rgb('--surface')), secondary: ratio(rgb('--text-secondary'),rgb('--surface')), accent: ratio(rgb('--on-accent'),rgb('--accent')), accentMaterialTop: ratio(rgb('--on-accent'), rgb('--aero-accent-fill').map(c=>c*(1-parseFloat(root.getPropertyValue('--aero-accent-highlight'))/100)+255*parseFloat(root.getPropertyValue('--aero-accent-highlight'))/100)) };
      });
      assert(contrast.body >= 4.5, `${theme}: primary reading contrast`);
      if (style === "aero") assert(contrast.accentMaterialTop >= 4.5, `${theme}: accent material label contrast ${contrast.accentMaterialTop}`);
      report.push({ theme, style, contrast, shell, panel });
      if (reviewThemes.includes(theme)) await shot(`settings-${theme}-${style}`);
    }
    await appearance('gruvbox-dark', 'aero');
    // Keyboard navigation retains visible focus and selected accent material.
    await page.locator('#settings-tab-appearance').focus();
    await page.keyboard.press('ArrowDown');
    const focused = page.locator('nav [role=tab]:focus');
    assert.equal(await focused.getAttribute('aria-selected'), 'true');
    assert.equal((await focused.evaluate(e=>getComputedStyle(e).outlineStyle)), 'solid');
    await page.locator('#settings-tab-integrations').click();
    await page.waitForSelector('article.aero-panel');
    for (const theme of reviewThemes) for (const style of ['aero', 'flat']) {
      await appearance(theme, style);
      await shot(`integrations-${theme}-${style}`);
    }
    await appearance('gruvbox-dark', 'aero');
    const toggle = page.getByRole('switch', { name: 'Enable server terminal' });
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await toggle.click();
    await page.waitForFunction(()=>document.querySelector('[aria-label="Enable server terminal"]').getAttribute('aria-checked') === 'false');
    await toggle.click();
    await page.locator('article.aero-panel summary').first().click();
    assert.equal(await page.locator('article.aero-panel details').first().getAttribute('open'), '');
    await shot('integrations-expanded');

    await load('projects');
    await page.waitForSelector('.project-card');
    for (const theme of reviewThemes) for (const style of ['aero', 'flat']) {
      await appearance(theme, style);
      assert.equal((await material('.project-card')).blur, 'none');
      await shot(`projects-${theme}-${style}`);
    }
    await appearance('gruvbox-dark', 'aero');
    const beforeHover = await material('.project-card');
    await page.locator('.project-card').hover();
    await page.waitForTimeout(200);
    const afterHover = await material('.project-card');
    assert.notEqual(beforeHover.shadow, afterHover.shadow);
    assert.equal(afterHover.transform, 'none');
    await shot('project-hover');
    await page.locator('.project-card-link').click();
    await page.waitForSelector('.project-composer');
    for (const theme of reviewThemes) for (const style of ['aero', 'flat']) {
      await appearance(theme, style);
      await shot(`workspace-${theme}-${style}`);
    }
    await appearance('gruvbox-dark', 'aero');
    const composer = await material('.project-composer');
    await page.locator('textarea[aria-label="Message"]').focus();
    assert.notEqual((await material('.project-composer')).shadow, composer.shadow);
    await shot('composer-focus');

    await load('aeroModelSettings');
    await page.waitForSelector('fieldset');
    for (const theme of reviewThemes) for (const style of ['aero', 'flat']) {
      await appearance(theme, style);
      await shot(`model-${theme}-${style}`);
    }
    await appearance('gruvbox-dark', 'aero');
    const primary = page.locator('button.aero-primary').last();
    const idle = await material('button.aero-primary');
    await primary.hover(); await page.waitForTimeout(160);
    assert.notEqual((await material('button.aero-primary')).image, idle.image);
    await page.mouse.down();
    assert.notEqual((await material('button.aero-primary')).shadow, idle.shadow);
    await shot('model-pressed');
    await page.mouse.move(5,5); await page.mouse.up();
    assert(await page.locator('input:disabled').count() > 0);
    await page.locator('input:not(:disabled)').first().focus();
    await shot('model-focus');
    // Footer remains outside the scrollable form body at both window sizes.
    for (const width of [1280, 700]) {
      await page.setViewportSize({ width, height: 740 });
      const footer = await page.locator('footer.aero-footer').boundingBox();
      assert(footer.y >= 0 && footer.y + footer.height <= 740);
    }
    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal((await material('.aero-header')).image, 'none');
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'reduce' });
    assert.equal(await primary.evaluate(e=>getComputedStyle(e).transitionDuration), '0s');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(()=>document.documentElement.dataset.bgAnimated='true');
    assert.equal((await material('.aero-dialog')).blur, 'none');
    assert.equal((await material('.aero-header')).blur, 'none');
    assert.deepEqual(errors, [], 'fixtures render without runtime errors');
    await fs.writeFile(path.join(output, 'theme-audit.json'), JSON.stringify(report, null, 2));
    console.log(`Aero materials: ${themes.length} themes × 2 appearances; Settings, MCP, projects, workspace, model dialog; interaction, focus, scrolling and fallback checks passed. Screenshots: ${output}`);
  } finally {
    await browser.close();
    if (process.env.AERO_REVIEW_DIR) await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
