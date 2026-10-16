import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

// This public keyring fixture is loaded only in a disposable browser profile.
const account = 'FrJPDJphtfZzgobT7b2CG9Mp79D6gVHR8L66T9mQ59Hu';
const seedHex = '55830e41db976a04df5775aeebf7751b3f599bec8f9d56568092b467aa64dad5698c828878ea5cdf84c10259bbe58f380ffddc94c5a1d868f55405429ea27c52';
const artifacts = resolve('docs/verification');
const profile = await mkdtemp(join(tmpdir(), 'clawd-wallet-consent-test-'));
let paymentRequests = 0;
// Public @wallet-standard/app (Apache-2.0) served to the fixture page as an ES module.
const walletStandardApp = await (await import('node:fs/promises')).readFile(resolve('node_modules/@wallet-standard/app/lib/esm/wallets.js'), 'utf8');
const server = createServer((request, response) => {
  if (request.url === '/wallet-standard-app.js') { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(walletStandardApp); return; }
  if (request.url === '/payment-required') { paymentRequests++; response.writeHead(402); response.end('Payment required'); return; }
  response.writeHead(200, { 'content-type': 'text/html' });
  response.end('<!doctype html><title>Public wallet consent fixture</title><h1>Wallet consent test</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  await mkdir(artifacts, { recursive: true });
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async ({ account, seedHex }) => {
    await chrome.storage.local.set({
      'helmsman:vault': { publicTestFixture: true },
      'helmsman:config': { selectedAccount: account, accountCount: 1, authorizedOrigins: [], agentMode: true },
    });
    await chrome.storage.session.set({ 'helmsman:unlocked': { mnemonic: 'public test fixture', seedHex } });
    globalThis.securityTest = { captures: 0, legacyBackendCalls: 0 };
    globalThis.securityTest.senders = [];
    chrome.runtime.onMessage.addListener((msg, sender) => {
      globalThis.securityTest.senders.push({ type: msg.type, method: msg.method, url: sender.url, origin: sender.origin, tab: sender.tab?.id });
    });
    chrome.tabs.captureVisibleTab = async () => { globalThis.securityTest.captures++; throw new Error('Screen capture is forbidden'); };
    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('chrome-extension:')) return originalFetch(url, init);
      if (/\/api\/(pay|sign|vision|computer)/.test(String(url))) globalThis.securityTest.legacyBackendCalls++;
      const body = init?.body ? JSON.parse(init.body) : null;
      // The popup may read its fixture balance; never contact an actual RPC.
      if (body?.method === 'getBalance') return Response.json({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: 0 } });
      throw new Error('External backend and RPC requests are forbidden in this test');
    };
  }, { account, seedHex });

  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await popupPage.getByRole('button', { name: 'Lock', exact: true }).waitFor();
  await popupPage.close();
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => window.solana && window.clawd);

  const legacyErrors = await page.evaluate(async () => {
    const calls = [() => window.clawd.pay('/payment-required'), () => window.clawd.see('capture'), () => window.clawd.snapshot(), () => window.clawd.signMessage('test', 'ethereum')];
    return Promise.all(calls.map(async call => { try { await call(); return null; } catch (error) { return error.code; } }));
  });
  assert.deepEqual(legacyErrors, [4200, 4200, 4200, 4200]);
  const forged = await page.evaluate(() => new Promise(resolve => {
    const id = crypto.randomUUID();
    const listener = event => { if (event.data?.channel === 'helmsman-reply' && event.data.id === id) { window.removeEventListener('message', listener); resolve(event.data); } };
    window.addEventListener('message', listener);
    window.postMessage({ channel: 'helmsman', id, msg: { type: 'popup:request', method: 'popup_getState' } }, '*');
  }));
  assert.equal(forged.error.code, 4200);
  assert.equal(await page.evaluate(async () => (await fetch('/payment-required')).status), 402);
  assert.equal(paymentRequests, 1);

  async function startAction(method, value) {
    const opened = context.waitForEvent('page', { timeout: 15000 });
    await page.evaluate(({ method, value }) => {
      globalThis.walletTestResult = null;
      const request = method === 'connect' ? window.solana.connect() : window.solana.signMessage(method === 'signBytes' ? new TextEncoder().encode(value) : value);
      request.then(result => { globalThis.walletTestResult = { result }; }, error => { globalThis.walletTestResult = { error: error.message }; });
    }, { method, value });
    const popup = await opened.catch(async error => {
      console.error(JSON.stringify({ walletResult: await page.evaluate(() => globalThis.walletTestResult), browserState: await worker.evaluate(() => globalThis.securityTest), pages: context.pages().map(page => page.url()) }, null, 2));
      throw error;
    });
    await popup.getByRole('button', { name: 'Approve', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => globalThis.walletTestResult), null);
    assert.match(await popup.locator('body').innerText(), new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return popup;
  }

  const connectPopup = await startAction('connect');
  await connectPopup.screenshot({ path: join(artifacts, 'connection-approval.png') });
  await connectPopup.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(() => globalThis.walletTestResult !== null);
  assert.equal((await page.evaluate(() => globalThis.walletTestResult)).result.publicKey, account);

  const rejectedPopup = await startAction('sign', 'public test message');
  await rejectedPopup.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.waitForFunction(() => globalThis.walletTestResult !== null);
  assert.match((await page.evaluate(() => globalThis.walletTestResult)).error, /User rejected/);

  // Phantom-style dApps pass UTF-8 bytes; the prompt must show the text, not "[object Object]".
  const signPopup = await startAction('signBytes', 'public test message');
  assert.match(await signPopup.locator('body').innerText(), /public test message/);
  await signPopup.screenshot({ path: join(artifacts, 'message-approval.png') });
  await signPopup.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(() => globalThis.walletTestResult !== null);
  const signed = (await page.evaluate(() => globalThis.walletTestResult)).result;
  assert.equal(nacl.sign.detached.verify(new TextEncoder().encode('public test message'), bs58.decode(signed.signature), bs58.decode(account)), true);
  // Wallet Standard: a dApp using @wallet-standard/app getWallets() discovers Clawd Wallet.
  const discovered = await page.evaluate(async () => {
    const { getWallets } = await import('/wallet-standard-app.js');
    const wallet = getWallets().get().find(w => w.name === 'Clawd Wallet');
    globalThis.clawdStandard = wallet;
    return wallet && { name: wallet.name, chains: [...wallet.chains], features: Object.keys(wallet.features).sort(), accountsBeforeConnect: wallet.accounts.length, icon: wallet.icon.slice(0, 22) };
  });
  assert.equal(discovered.name, 'Clawd Wallet');
  assert.deepEqual(discovered.chains, ['solana:mainnet', 'solana:devnet', 'solana:testnet']);
  assert.equal(discovered.accountsBeforeConnect, 0);
  assert.equal(discovered.icon, 'data:image/webp;base64');
  // This origin was approved above, so a silent standard:connect succeeds without a popup.
  const stdAccounts = await page.evaluate(async () => (await globalThis.clawdStandard.features['standard:connect'].connect({ silent: true })).accounts.map(a => a.address));
  assert.deepEqual(stdAccounts, [account]);
  const stdOpened = context.waitForEvent('page', { timeout: 15000 });
  await page.evaluate(() => {
    globalThis.walletTestResult = null;
    const w = globalThis.clawdStandard;
    w.features['solana:signMessage'].signMessage({ account: w.accounts[0], message: new TextEncoder().encode('wallet standard test') })
      .then(([r]) => { globalThis.walletTestResult = { signature: [...r.signature] }; }, e => { globalThis.walletTestResult = { error: e.message }; });
  });
  const stdPopup = await stdOpened;
  await stdPopup.getByRole('button', { name: 'Approve', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => globalThis.walletTestResult), null, 'standard signMessage must wait for approval');
  await stdPopup.screenshot({ path: join(artifacts, 'wallet-standard-approval.png') });
  await stdPopup.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(() => globalThis.walletTestResult !== null);
  const stdSig = await page.evaluate(() => globalThis.walletTestResult);
  assert.equal(nacl.sign.detached.verify(new TextEncoder().encode('wallet standard test'), Uint8Array.from(stdSig.signature), bs58.decode(account)), true);
  // Fresh unconnected origin: wallet discoverable, zero accounts, silent connect refused.
  const other = await context.newPage();
  await other.goto(origin.replace('127.0.0.1', 'localhost'));
  const strangers = await other.evaluate(async () => {
    const { getWallets } = await import('/wallet-standard-app.js');
    const w = getWallets().get().find(x => x.name === 'Clawd Wallet');
    let silent; try { await w.features['standard:connect'].connect({ silent: true }); silent = 'connected'; } catch (e) { silent = e.message; }
    return { found: !!w, accounts: w.accounts.length, silent, state: await window.solana.getState(), version: window.clawd.version };
  });
  assert.deepEqual(strangers, { found: true, accounts: 0, silent: strangers.silent, state: { state: 'unknown' }, version: undefined });
  assert.match(strangers.silent, /Unauthorized/);
  await other.close();
  const walletStandard = { discoveredByGetWallets: true, silentConnectApprovedOrigin: true, signMessageNeedsApproval: true, unconnectedOriginSeesNoAccounts: true };
  const effects = await worker.evaluate(() => ({ captures: globalThis.securityTest.captures, legacyBackendCalls: globalThis.securityTest.legacyBackendCalls }));
  assert.deepEqual(effects, { captures: 0, legacyBackendCalls: 0 });
  const report = { checkedAt: new Date().toISOString(), version: '0.5.0', walletStandard, profile: 'disposable and removed', installedInUserProfile: false, normalConnectionApproval: true, signingApprovalAndRejection: true, fixtureSignatureVerified: true, legacyCommandsBlocked: true, http402Preserved: true, ...effects, fundedTransactions: false };
  await writeFile(join(artifacts, 'browser-consent.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (context) await context.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
