// Builds Chrome Web Store artwork from the real dist/ build.
// Offline public test fixture only: devnet selected, all RPC mocked, no real keys.
// Prereq: npm run test:browser (produces docs/verification/tx-preview*.png, auto-approve-form.png).
import { mkdtemp, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
const out = resolve('store-assets/0.5.1');
await mkdir(out, { recursive: true });
const account = 'FrJPDJphtfZzgobT7b2CG9Mp79D6gVHR8L66T9mQ59Hu';
const seedHex = '55830e41db976a04df5775aeebf7751b3f599bec8f9d56568092b467aa64dad5698c828878ea5cdf84c10259bbe58f380ffddc94c5a1d868f55405429ea27c52';
const profile = await mkdtemp(join(tmpdir(), 'clawd-store-'));
const ext = resolve('dist');
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
const b64 = async (p) => 'data:image/png;base64,' + (await readFile(p)).toString('base64');
try {
  const w = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const id = new URL(w.url()).host;
  await w.evaluate(async ({ account, seedHex }) => {
    await chrome.storage.local.set({ 'helmsman:vault': { publicTestFixture: true }, 'helmsman:config': { selectedAccount: account, accountCount: 1, authorizedOrigins: [], agentMode: true, selectedNetwork: { title: 'Devnet', cluster: 'devnet', endpoint: 'https://api.devnet.solana.com' } } });
    await chrome.storage.session.set({ 'helmsman:unlocked': { mnemonic: 'public test fixture', seedHex } });
    const of = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (u, i) => { if (String(u).startsWith('chrome-extension:')) return of(u, i); const b = i?.body ? JSON.parse(i.body) : null; if (b?.method === 'getBalance') return Response.json({ jsonrpc: '2.0', id: b.id, result: { context: { slot: 1 }, value: 2500000000 } }); throw new Error('offline'); };
  }, { account, seedHex });
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 380, height: 600 });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.getByRole('button', { name: 'Lock', exact: true }).waitFor();
  await p.waitForTimeout(600);
  const homePath = join(profile, 'home.png');
  await p.screenshot({ path: homePath, fullPage: true });
  const homeH = await p.evaluate(() => document.documentElement.scrollHeight);
  await p.getByPlaceholder(/Ask Clawd/).fill('What does a token approval let a site do?');
  const asstTop = await p.evaluate(() => [...document.querySelectorAll('h2')].find(h => /assistant/i.test(h.textContent)).closest('.card').getBoundingClientRect().top + scrollY);
  const asstPath = join(profile, 'asst.png');
  await p.screenshot({ path: asstPath, fullPage: true });

  const icon = await b64('public/icons/icon-128.png');
  const home = await b64(homePath), asst = await b64(asstPath);
  const v = (f) => b64(join('docs/verification', f));
  // [img, naturalWidth(css px of popup column), cropTop, cropHeight, imageWidth]
  const slides = [
    { h: 'A clean, focused wallet', s: 'Brand, account, network and Lock in one tidy header, with your accounts and balance right below.', img: home, iw: 380, y: 0, ch: 300 },
    { h: 'See every change before you sign', s: 'Transaction preview with SOL and token balance changes, fees, compute and the programs involved.', img: await v('tx-preview.png'), iw: 1100, y: 0, ch: 790 },
    { h: 'Risk warnings you can’t miss', s: 'Unlimited token approvals, owner changes and other dangerous instructions are flagged and always need a manual review.', img: await v('tx-preview-warnings.png'), iw: 1100, y: 0, ch: 817 },
    { h: 'Per-site auto-approve, with limits', s: 'Opt in per site: expiry, total and per-transaction SOL caps and an allowed-program list. Locking ends every session.', img: await v('auto-approve-form.png'), iw: 1100, y: 500, ch: 690 },
    { h: 'Built-in AI assistant', s: 'Ask Clawd for help in plain language. The assistant can’t sign or send anything, and reminds you never to share your recovery phrase.', img: asst, iw: 380, y: Math.max(0, asstTop - 8), ch: 200 },
  ];
  const css = `*{box-sizing:border-box}body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,"Helvetica Neue",sans-serif;color:#f4f2ff;
    background:radial-gradient(1200px 700px at 85% 10%,rgba(153,69,255,.38),transparent 60%),radial-gradient(900px 600px at 0% 100%,rgba(20,241,149,.16),transparent 60%),#07060c;overflow:hidden}
    .brand{display:flex;align-items:center;gap:14px}.brand img{border-radius:14px;filter:drop-shadow(0 0 18px rgba(153,69,255,.6))}
    .name{font-weight:800;letter-spacing:.06em}.sd{color:#b07bff;text-transform:uppercase;letter-spacing:.14em;font-weight:600}
    .links{color:#14f195;text-transform:uppercase;letter-spacing:.12em;font-weight:600}
    .frame{border-radius:18px;overflow:hidden;border:1px solid rgba(176,123,255,.45);box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 60px rgba(153,69,255,.25);background:#0b0b0f}`;
  const page = await ctx.newPage();
  for (const [i, sl] of slides.entries()) {
    const maxH = 680, colW = 380;
    const sc = Math.min(1.3, maxH / sl.ch);
    const fw = Math.round(colW * sc), fh = Math.round(sl.ch * sc);
    const html = `<style>${css}</style><body style="width:1280px;height:800px;display:flex;align-items:center;padding:0 90px;gap:80px">
      <div style="flex:1;min-width:0">
        <div class="brand"><img src="${icon}" width="64" height="64"><div class="name" style="font-size:30px">CLAWD WALLET</div></div>
        <h1 style="font-size:54px;line-height:1.08;margin:42px 0 22px;font-weight:800">${sl.h}</h1>
        <p style="font-size:23px;line-height:1.45;color:#c9c3dd;margin:0">${sl.s}</p>
        <div class="sd" style="font-size:16px;margin-top:56px">Superintelligent Design</div>
        <div class="links" style="font-size:15px;margin-top:8px">clawdchain.trade · musebook.trade</div>
      </div>
      <div class="frame" style="width:${fw}px;height:${fh}px;flex:none;position:relative">
        <img src="${sl.img}" style="position:absolute;left:0;top:${-sl.y * sc}px;width:${sl.iw * sc}px">
      </div></body>`;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.setContent(html); await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, `screenshot-${i + 1}.png`) });
  }
  const promo = (W, H, big) => `<style>${css}</style><body style="width:${W}px;height:${H}px;display:flex;align-items:center;justify-content:center;gap:${big ? 60 : 22}px">
    <img src="${icon}" width="${big ? 220 : 110}" height="${big ? 220 : 110}" style="border-radius:${big ? 44 : 24}px;filter:drop-shadow(0 0 30px rgba(153,69,255,.7))">
    <div><div class="name" style="font-size:${big ? 86 : 38}px">CLAWD</div>
    <div style="font-size:${big ? 30 : 15}px;color:#c9c3dd;margin:${big ? 10 : 4}px 0 ${big ? 26 : 12}px">${big ? 'Solana wallet · you approve every signature' : 'Solana wallet you control'}</div>
    <div class="sd" style="font-size:${big ? 20 : 11}px">Superintelligent Design</div>
    <div class="links" style="font-size:${big ? 18 : 10}px;margin-top:6px">clawdchain.trade · musebook.trade</div></div></body>`;
  for (const [W, H, n, big] of [[440, 280, 'promo-small-440x280.png', false], [1400, 560, 'marquee-1400x560.png', true]]) {
    await page.setViewportSize({ width: W, height: H });
    await page.setContent(promo(W, H, big)); await page.waitForTimeout(150);
    await page.screenshot({ path: join(out, n) });
  }
  console.log('store assets written to', out);
} finally { await ctx.close(); await rm(profile, { recursive: true, force: true }); }
