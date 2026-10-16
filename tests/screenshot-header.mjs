// Captures the popup header + footer for docs/verification. Public test fixture only; all network blocked.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
const account = 'FrJPDJphtfZzgobT7b2CG9Mp79D6gVHR8L66T9mQ59Hu';
const seedHex = '55830e41db976a04df5775aeebf7751b3f599bec8f9d56568092b467aa64dad5698c828878ea5cdf84c10259bbe58f380ffddc94c5a1d868f55405429ea27c52';
const profile = await mkdtemp(join(tmpdir(), 'clawd-hdr-'));
const ext = resolve('dist');
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
try {
  const w = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const id = new URL(w.url()).host;
  await w.evaluate(async ({ account, seedHex }) => {
    await chrome.storage.local.set({ 'helmsman:vault': { publicTestFixture: true }, 'helmsman:config': { selectedAccount: account, accountCount: 1, authorizedOrigins: [], agentMode: true } });
    await chrome.storage.session.set({ 'helmsman:unlocked': { mnemonic: 'public test fixture', seedHex } });
    const of = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (u, i) => { if (String(u).startsWith('chrome-extension:')) return of(u, i); const b = i?.body ? JSON.parse(i.body) : null; if (b?.method === 'getBalance') return Response.json({ jsonrpc: '2.0', id: b.id, result: { context: { slot: 1 }, value: 0 } }); throw new Error('offline'); };
  }, { account, seedHex });
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 380, height: 600 });
  await p.goto(`chrome-extension://${id}/popup.html`);
  await p.getByRole('button', { name: 'Lock', exact: true }).waitFor();
  await p.waitForTimeout(500);
  await p.screenshot({ path: resolve('docs/verification/header-0.5.1.png'), fullPage: true });
  console.log('saved docs/verification/header-0.5.1.png');
} finally { await ctx.close(); await rm(profile, { recursive: true, force: true }); }
