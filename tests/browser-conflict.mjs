// Regression for 0.5.1 "TypeError: Cannot redefine property: solana": another
// wallet (Phantom-style) defines window.solana non-configurable before our
// MAIN-world script runs. Real Chromium + built dist/; offline local fixture page.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
const srv = createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<!doctype html><title>conflict fixture</title>ok'); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const profile = await mkdtemp(join(tmpdir(), 'clawd-conflict-'));
const ext = resolve('dist');
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
try {
  const discover = () => { const n = []; window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register: (...w) => { n.push(...w.map((x) => x.name)); return () => {}; } } })); return n; };
  for (const mode of ['none', 'phantom-nonconfigurable']) {
    const page = await ctx.newPage();
    if (mode !== 'none') await page.addInitScript(() => Object.defineProperty(window, 'solana', { value: { isPhantom: true }, writable: false, configurable: false }));
    const errors = []; const warns = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'warning') warns.push(m.text()); });
    await page.goto(`http://127.0.0.1:${srv.address().port}/`);
    await page.waitForFunction(() => window.clawd);
    const r = await page.evaluate(`(${discover})()`).then(async (names) => ({ names, phantom: await page.evaluate(() => !!window.solana?.isPhantom), clawd: await page.evaluate(() => !!window.solana?.isClawd || !!window.clawd?.isClawd) }));
    assert.deepEqual(errors, [], `${mode}: page errors`);
    assert.deepEqual(r.names, ['Clawd Wallet'], `${mode}: registered once via Wallet Standard`);
    assert.equal(r.phantom, mode !== 'none', `${mode}: other wallet's window.solana untouched`);
    if (mode !== 'none') assert.ok(warns.some((w) => /window\.solana is already provided/.test(w)));
    console.log(JSON.stringify({ mode, ...r, errors: errors.length }));
    await page.close();
  }
  console.log('browser-conflict ok');
} finally { await ctx.close(); srv.close(); await rm(profile, { recursive: true, force: true }); }
