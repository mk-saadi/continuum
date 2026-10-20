// Electron UI harness for the Phase 2.0D spending dashboard. Verifies the
// overview, filters, model detail, provider breakdown, attribution, pricing
// history, local "not applicable" states, theme variables, and that no
// inference method is ever called.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const esbuild = require('esbuild');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'spending-dashboard-ui-'));
  const window = new BrowserWindow({ show: false, width: 1280, height: 1100, webPreferences: { sandbox: true } });
  try {
    await esbuild.build({ entryPoints: [path.join(__dirname, 'fixtures/spendingDashboard.jsx')], bundle: true,
      outfile: path.join(directory, 'fixture.js'), define: { 'process.env.NODE_ENV': '"test"' } });
    const assets = path.join(__dirname, '../dist/assets');
    const css = (await fs.readdir(assets)).find(file => file.endsWith('.css'));
    await fs.copyFile(path.join(assets, css), path.join(directory, 'fixture.css'));
    await fs.writeFile(path.join(directory, 'index.html'), '<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>');
    await window.loadFile(path.join(directory, 'index.html'));
    await window.webContents.executeJavaScript(`(async () => {
      const wait = (ms = 140) => new Promise(resolve => setTimeout(resolve, ms));
      const check = (condition, text) => { if (!condition) throw new Error(text); };
      const body = () => document.getElementById('root').textContent;
      const tab = label => [...document.querySelectorAll('[role="tab"]')].find(element => element.textContent.trim() === label);
      const button = (scope, label) => [...scope.querySelectorAll('button')].find(element => element.textContent.trim() === label);
      const fire = (element, type = 'change') => element.dispatchEvent(new Event(type, { bubbles: true }));
      const selectByLabel = prefix => {
        const label = [...document.querySelectorAll('label')].find(element => element.textContent.trim().startsWith(prefix));
        if (!label) throw new Error('Missing select labelled ' + prefix);
        return label.querySelector('select');
      };
      const metric = label => {
        const heading = [...document.querySelectorAll('p')].find(element => element.textContent.trim() === label);
        if (!heading) throw new Error('Missing metric ' + label);
        return heading.parentElement.textContent;
      };

      await wait();
      check(body().includes('Cloud spending & usage'), 'the dashboard heading is shown');
      check(body().includes('Read-only aggregation') && body().includes('UTC'), 'the read-only UTC contract is stated');
      check(metric('Total priced spend').includes('$0.0183'), 'total priced spend is shown');
      check(metric('Rate-based estimate').includes('$0.0121'), 'rate-based estimate is separate');
      check(metric('Provider-reported').includes('$0.0062'), 'provider-reported spend is separate');
      check(metric('Data completeness').includes('Estimated'), 'data completeness is stated');
      check(metric('Net cache savings').includes('+$0.0042'), 'net cache savings is signed');
      check(document.querySelector('figure[aria-label*="Spending over time"]'), 'the timeline chart is rendered');
      check(document.querySelector('.recharts-wrapper'), 'Recharts produced a chart surface');
      check(body().includes('daily buckets') && body().includes('weeks start Monday') === false, 'the UTC daily bucket label is explicit');

      // Theme compatibility: cards consume the app theme variables.
      const card = document.querySelector('#usage-costs-panel-overview section');
      document.documentElement.setAttribute('data-theme', 'light');
      await wait(30);
      const light = getComputedStyle(card).backgroundColor;
      document.documentElement.setAttribute('data-theme', 'dark');
      await wait(30);
      const dark = getComputedStyle(card).backgroundColor;
      check(light && dark && light !== dark, 'dashboard surfaces follow the active theme variables');
      check(light !== 'rgba(0, 0, 0, 0)' && dark !== 'rgba(0, 0, 0, 0)', 'dashboard surfaces are painted, not transparent');

      // Local-only selection: cost is "not applicable", never $0.00.
      let providerSelect = selectByLabel('Provider');
      providerSelect.value = 'local';
      fire(providerSelect);
      await wait();
      check(metric('Total priced spend').includes('Not applicable'), 'local-only selection shows not applicable');
      check(!metric('Total priced spend').includes('$0.00'), 'local-only selection never shows $0.00');
      check(metric('Provider-reported').includes('Not applicable'), 'local provider-reported cost is not applicable');
      check(window.queries.some(query => query.method === 'getSpendingDashboard' && query.options.providerId === 'local'), 'the local filter reaches the backend');
      button(document, 'Reset filters').click();
      await wait();

      // Model table, tiny cost formatting, and detail view.
      tab('Models').click();
      await wait();
      const modelsPanel = document.getElementById('usage-costs-panel-models');
      check(modelsPanel.textContent.includes('Spending by model'), 'the model table is shown');
      check(modelsPanel.textContent.includes('< $0.0001'), 'a tiny non-zero model cost never renders as $0.00');
      check(modelsPanel.textContent.includes('llama-3') && modelsPanel.textContent.includes('Not applicable'), 'a local model row is not applicable');
      button(modelsPanel, 'claude-sonnet-5').click();
      await wait();
      check(modelsPanel.textContent.includes('Rate snapshots recorded for this model'), 'the model detail loads');
      check(modelsPanel.textContent.includes('anthropic catalog'), 'recorded catalog snapshots are shown');
      check(modelsPanel.textContent.includes('Effective date unavailable'), 'the UI does not invent an effective date');
      check(modelsPanel.textContent.includes('Mixed evidence, never fully verified'), 'combined spend keeps its mixed-evidence label');
      check(window.queries.some(query => query.method === 'getUsageModelDetail'
        && query.options.modelId === 'claude-sonnet-5' && query.options.providerId === 'anthropic-p'), 'provider identity is passed to model detail');

      // Provider breakdown filters the model view.
      tab('Providers').click();
      await wait();
      const providersPanel = document.getElementById('usage-costs-panel-providers');
      check(providersPanel.textContent.includes('Spending by provider'), 'the provider breakdown is shown');
      check(providersPanel.textContent.includes('Direct Anthropic') && providersPanel.textContent.includes('OpenRouter'), 'provider routes stay distinct');
      check(providersPanel.textContent.includes('Not applicable'), 'local provider usage is not applicable');
      button(providersPanel, 'Claude').click();
      await wait();
      check(selectByLabel('Provider').value === 'anthropic-p', 'selecting a provider applies the shared filter');
      check(tab('Models').getAttribute('aria-selected') === 'true', 'selecting a provider opens the filtered model view');
      button(document, 'Reset filters').click();
      await wait();

      // Attribution and paginated records.
      tab('Conversations').click();
      await wait();
      const conversations = document.getElementById('usage-costs-panel-conversations');
      check(conversations.textContent.includes('Where usage originated'), 'attribution is shown');
      check(conversations.textContent.includes('Chat one') && conversations.textContent.includes('$0.0151'), 'conversation totals are attributed');
      const groupSelect = selectByLabel('Group by');
      groupSelect.value = 'agent';
      fire(groupSelect);
      await wait();
      check(conversations.textContent.includes('Subagent · Researcher'), 'sub-agent attribution is separate from the main agent');
      check(conversations.textContent.includes('Main agent'), 'main-agent attribution is shown');
      button(conversations, 'Show records').click();
      await wait();
      check(conversations.textContent.includes('Detailed usage records'), 'paginated records are shown');
      check(conversations.textContent.includes('of 6'), 'record pagination states the total');
      check(conversations.textContent.includes('Chat two'), 'records identify the conversation');
      check(window.queries.some(query => query.method === 'getSpendingRecords' && query.options.limit === 25), 'records request a bounded page');

      // Pricing history, expanded evidence, and no invented effective date.
      tab('Pricing history').click();
      await wait();
      const pricing = document.getElementById('usage-costs-panel-pricing');
      check(pricing.textContent.includes('Pricing history'), 'pricing history is shown');
      check(pricing.textContent.includes('Read-only evidence'), 'pricing history is labelled read-only');
      check(pricing.textContent.includes('anthropic catalog'), 'the recorded source is shown');
      check(pricing.textContent.includes('$3.00') && pricing.textContent.includes('$15.00'), 'recorded input and output rates are shown');
      button(pricing, 'anthropic catalog').click();
      await wait();
      check(pricing.textContent.includes('provider-announced effective date'), 'the effective-date limitation is stated');
      check(pricing.textContent.includes('Changing today') || pricing.textContent.includes('does not rewrite this row'), 'historical rows are not repriced');
      check(pricing.textContent.includes('of 2 rate snapshots'), 'pricing history pagination states its total');

      // Honest error state and recovery.
      providerSelect = selectByLabel('Provider');
      const broken = document.createElement('option');
      broken.value = 'error-p';
      broken.textContent = 'Broken provider';
      providerSelect.appendChild(broken);
      providerSelect.value = 'error-p';
      fire(providerSelect);
      await wait();
      const alert = document.querySelector('[role="alert"]');
      check(alert && alert.textContent.includes('Dashboard unavailable'), 'backend errors are surfaced');
      button(document, 'Reset filters').click();
      await wait();
      check(!document.querySelector('[role="alert"]'), 'resetting filters clears the error');
      check(metric('Total priced spend').includes('$0.0183'), 'the dashboard recovers after reset');

      // No inference path exists or was called.
      const allowed = new Set(['getSpendingDashboard', 'getSpendingAttribution', 'getSpendingRecords', 'getPricingHistory', 'getUsageModelDetail']);
      check(window.queries.every(query => allowed.has(query.method)), 'only read-only dashboard methods were called');
      check(window.queries.every(query => !/chat|inference|completion/i.test(query.method)), 'no inference method name was used');
      check(window.inferenceCalls === 0, 'no inference request was made');
      check(window.queries.length > 8, 'the dashboard exercised the full read-only API');
    })()`);
    console.log('Spending dashboard UI: overview, filters, local not-applicable, tiny costs, model detail, providers, attribution, records, pricing history, errors, theme and no-inference checks passed.');
  } finally { window.destroy(); await fs.rm(directory, { recursive: true, force: true }); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
