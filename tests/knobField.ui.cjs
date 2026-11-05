// npm run build && CHROME_PATH=/usr/bin/google-chrome node tests/knobField.ui.cjs
const { chromium } = require('playwright');
const esbuild = require('esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
(async () => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'continuum-knob-'));
 await esbuild.build({ entryPoints: ['tests/fixtures/knobField.jsx'], bundle: true, outfile: path.join(directory,'fixture.js'), loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' } });
 const assets = path.resolve('dist/assets');
 const css = (await fs.readdir(assets)).find(n => n.endsWith('.css'));
 await fs.writeFile(path.join(directory,'index.html'), `<html data-theme="dark" data-appearance="skeu"><head><link rel="stylesheet" href="${pathToFileURL(path.join(assets,css)).href}"></head><body style="background:var(--bg-secondary)"><div id="root"></div><script src="fixture.js"></script></body></html>`);
 const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH });
 try {
 const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
 const errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.goto(pathToFileURL(path.join(directory,'index.html')).href);
 const small = page.getByLabel('Small dial'), large = page.getByLabel('Large dial');
 assert.equal((await small.boundingBox()).width,48);
 assert.equal((await large.boundingBox()).width,112);
 const fonts = await page.locator('.knob-field__value').evaluateAll(es=>es.map(e=>getComputedStyle(e).fontSize));
 assert.equal(fonts[0],fonts[1]);
 const labelFonts = await page.locator('label').evaluateAll(es=>es.slice(0,2).map(e=>getComputedStyle(e).fontSize));
 assert.equal(labelFonts[0],labelFonts[1]);
 await small.focus(); await page.keyboard.press('ArrowUp'); assert.equal(await small.inputValue(),'1.05');
 assert.deepEqual(await page.evaluate(()=>window.commits),[1.05]);
 const box = await small.boundingBox();
 await page.mouse.move(box.x+24,box.y+24); await page.mouse.down();
 await page.mouse.move(box.x+24,box.y-100,{steps:10}); await page.mouse.up();
 assert.equal(await small.inputValue(),'2');
 assert.equal((await page.evaluate(()=>window.commits)).length,2);
 await page.keyboard.press('Home'); assert.equal(await small.inputValue(),'0');
 await page.keyboard.press('End'); assert.equal(await small.inputValue(),'2');
 assert(await page.getByLabel('Disabled dial').isDisabled());
 await page.locator('summary').first().click();
 const profile = page.locator('details').first();
 await profile.locator('.knob-field').first().waitFor();
 assert.equal(await profile.locator('.knob-field').count(),4);
 await profile.getByLabel('Temperature').focus(); await page.keyboard.press('ArrowDown');
 await profile.getByRole('button',{name:'Save defaults',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.saved),[{path:'test-model',patch:{temperature:.95}}]);
 await page.locator('summary').nth(1).click();
 await page.locator('details').nth(1).locator('input[type=range]').first().waitFor();
 assert.equal(await page.locator('details').nth(1).locator('.knob-field').count(),0);
 assert.equal(await page.locator('details').nth(1).locator('input[type=range]').count(),4);
 for (const theme of ['dark','light']) for (const appearance of ['flat','aero','skeu']) {
  await page.evaluate(t=>window.knobTheme(t),theme);
  await page.evaluate(a=>document.documentElement.dataset.appearance=a,appearance);
  await page.screenshot({path:path.join(directory,theme+'-'+appearance+'.png')});
 }
 assert.deepEqual(errors,[]);
 console.log('Knob sizing, keyboard, drag/clamp, commits, disabled state, profile saves and scope passed. Screenshots: '+directory);
 } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
