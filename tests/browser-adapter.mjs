// Real-browser check (disposable profile, public test key, mocked RPC, nothing
// broadcast): @solana/wallet-adapter-react with wallets={[]} discovers Clawd
// Wallet via Wallet Standard, shows it in the WalletModal, connects, signs a
// message and a devnet transaction. Also captures the transaction preview and
// exercises a per-site auto-approve session.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { ComputeBudgetProgram, PublicKey, SystemProgram, Transaction, TransactionInstruction } from '@solana/web3.js';

const account = 'FrJPDJphtfZzgobT7b2CG9Mp79D6gVHR8L66T9mQ59Hu';
const seedHex = '55830e41db976a04df5775aeebf7751b3f599bec8f9d56568092b467aa64dad5698c828878ea5cdf84c10259bbe58f380ffddc94c5a1d868f55405429ea27c52';
const destination = '59dqcH5gJr6M2R5hFtmmXUfNmgGJWfQh8Gx33fnAReKo';
const artifacts = resolve('docs/verification');
const appDir = resolve('tests/adapter-app/dist');
const profile = await mkdtemp(join(tmpdir(), 'clawd-wallet-adapter-test-'));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  const path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  try { const body = await readFile(join(appDir, path)); res.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const me = new PublicKey(account);
const b64 = (tx) => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
const BH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

let context;
const step = (m) => console.error('step:', m);
const watchdog = setTimeout(() => { console.error('WATCHDOG: test hung'); process.exit(2); }, 150_000);
try {
  await mkdir(artifacts, { recursive: true });
  const extension = resolve('dist');
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1100, height: 800 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  // Mocked devnet JSON-RPC at the network layer (survives service-worker restarts).
  // The fixture account holds 2 SOL. Every other external host is blocked.
  const rpcLog = [];
  const acct = (lamports) => ({ data: ['', 'base64'], executable: false, lamports, owner: '11111111111111111111111111111111', rentEpoch: 0, space: 0 });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (route) => {
    const req = route.request();
    if (!req.url().startsWith('https://api.devnet.solana.com')) { rpcLog.push('BLOCKED ' + req.url()); return route.abort(); }
    const body = req.postDataJSON();
    rpcLog.push(body.method);
    const result = (() => {
      switch (body.method) {
        case 'getBalance': return { context: { slot: 1 }, value: 2e9 };
        case 'getMultipleAccounts': return { context: { slot: 1 }, value: body.params[0].map((a) => (a === account ? acct(2e9) : null)) };
        case 'getFeeForMessage': return { context: { slot: 1 }, value: 5300 };
        case 'simulateTransaction': {
          const raw = Buffer.from(body.params[0], 'base64').toString('latin1');
          const debit = raw.includes('UNLIMITED') ? 5300 : raw.includes('Clawd preview demo') ? 50_005_300 : 6000;
          return { context: { slot: 1 }, value: { err: null, logs: ['Program 11111111111111111111111111111111 invoke [1]', 'Program 11111111111111111111111111111111 success'], unitsConsumed: 450, returnData: null, accounts: body.params[1].accounts.addresses.map((a) => (a === account ? acct(2e9 - debit) : null)) } };
        }
        default: return null; // sendTransaction etc. are never expected
      }
    })();
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async ({ account, seedHex }) => {
    await chrome.storage.local.set({
      'helmsman:vault': { publicTestFixture: true },
      'helmsman:config': { selectedAccount: account, accountCount: 1, authorizedOrigins: [], agentMode: false, selectedNetwork: { title: 'Devnet', cluster: 'devnet', endpoint: 'https://api.devnet.solana.com' } },
    });
    await chrome.storage.session.set({ 'helmsman:unlocked': { mnemonic: 'public test fixture', seedHex } });
  }, { account, seedHex });
  const warm = await context.newPage();
  await warm.goto(`chrome-extension://${extensionId}/popup.html`);
  await warm.getByRole('button', { name: 'Lock', exact: true }).waitFor();
  await warm.close();

  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => window.__adapter?.wallets?.some((w) => w.name === 'Clawd Wallet'));
  const listed = await page.evaluate(() => window.__adapter.wallets);
  assert.deepEqual(listed.find((w) => w.name === 'Clawd Wallet'), { name: 'Clawd Wallet', readyState: 'Installed' });

  await page.evaluate(() => { window.__msgs = []; window.addEventListener('message', (e) => window.__msgs.push(JSON.stringify(e.data).slice(0, 200))); });
  step('modal');
  // WalletModal lists Clawd Wallet.
  await page.getByRole('button', { name: /Select Wallet/i }).click();
  const item = page.locator('.wallet-adapter-modal-list').getByRole('button', { name: /Clawd Wallet/ });
  await item.waitFor();
  await page.screenshot({ path: join(artifacts, 'wallet-adapter-modal.png') });
  const nextPopup = () => context.waitForEvent('page', { timeout: 15000 });
  let popupP = nextPopup();
  popupP.catch(() => {});
  await item.click({ timeout: 5000 }).catch(async (e) => { await page.screenshot({ path: '/tmp/adapter-fail.png' }); throw e; });
  // Selecting in the modal selects the wallet; the WalletMultiButton then offers
  // "Connect" (adapter-ui 0.9.x). Trigger that same connect() from useWallet.
  await page.waitForFunction(() => window.__adapter.selected === 'Clawd Wallet');
  const first = await Promise.race([popupP.then(() => 'popup'), new Promise((r) => setTimeout(() => r('button'), 2500))]);
  if (first === 'button') await page.evaluate(() => { window.__connecting = window.__connect(); });
  let popup = await popupP.catch(async (e) => { await page.screenshot({ path: '/tmp/adapter-fail.png' }); console.error(await page.evaluate(() => JSON.stringify({ a: window.__adapter, e: window.__adapterErrors, msgs: window.__msgs, buttons: [...document.querySelectorAll('button')].map(b => b.textContent) }))); throw e; });
  await popup.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(() => window.__adapter.connected);
  assert.equal(await page.evaluate(() => window.__adapter.publicKey), account);

  step('connected');
  // signMessage through the adapter.
  popupP = nextPopup();
  await page.click('#sign-message');
  popup = await popupP;
  await popup.getByText('wallet-adapter compatibility test').waitFor();
  await popup.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#out').textContent.includes('signature'));
  const m = JSON.parse(await page.textContent('#out'));
  assert.ok(nacl.sign.detached.verify(new TextEncoder().encode('wallet-adapter compatibility test'), bs58.decode(m.signature), bs58.decode(account)));

  step('message signed');
  // signTransaction (devnet) through the adapter, with the preview screen.
  popupP = nextPopup();
  await page.click('#sign-tx');
  popup = await popupP;
  await popup.locator('[data-testid=tx-preview]').waitFor();
  assert.match(await popup.locator('body').innerText(), /System Program/);
  await popup.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#out').textContent.includes('"kind":"tx"'));
  const t = JSON.parse(await page.textContent('#out'));
  assert.equal(t.verified, true);

  step('adapter tx signed');
  // Preview screenshot: compute budget + SOL transfer + memo.
  const memo = new TransactionInstruction({ programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), keys: [], data: Buffer.from('Clawd preview demo') });
  const demo = new Transaction({ recentBlockhash: BH, feePayer: me }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    SystemProgram.transfer({ fromPubkey: me, toPubkey: new PublicKey(destination), lamports: 50_000_000 }), memo);
  popupP = nextPopup();
  await page.evaluate((tx) => { globalThis.r1 = window.solana.signTransaction(tx); }, b64(demo));
  popup = await popupP;
  await popup.locator('[data-testid=tx-preview]').waitFor();
  const text = await popup.locator('body').innerText();
  assert.match(text, /-0\.0500053/); assert.match(text, /Compute Budget/); assert.match(text, /Memo/);
  await popup.screenshot({ path: join(artifacts, 'tx-preview.png'), fullPage: true });
  // Enable auto-approve from the approval screen (programs default to this tx's).
  await popup.locator('#auto-toggle').check();
  await popup.getByLabel('Max total SOL').fill('0.5');
  await popup.getByLabel('Max SOL per transaction').fill('0.1');
  await popup.screenshot({ path: join(artifacts, 'auto-approve-form.png'), fullPage: true });
  await popup.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.evaluate(() => globalThis.r1);

  step('auto enabled');
  // A second similar tx is auto-approved: no popup, logged as auto.
  let opened = 0;
  const onPage = () => { opened++; };
  context.on('page', onPage);
  const signed2 = await page.evaluate((tx) => window.solana.signTransaction(tx), b64(demo));
  assert.ok(signed2.signedTransaction);
  await page.waitForTimeout(1000);
  context.off('page', onPage);
  assert.equal(opened, 0, 'auto-approved tx must not open a popup');
  const activity = await worker.evaluate(async () => (await chrome.storage.local.get('clawd:activity'))['clawd:activity']);
  assert.equal(activity[0].auto, true);

  step('auto approved');
  // Dangerous tx: unlimited token approval -> manual review with warnings even with a session.
  const approve = new TransactionInstruction({ programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), keys: [
    { pubkey: new PublicKey(destination), isSigner: false, isWritable: true }, { pubkey: new PublicKey('11111111111111111111111111111112'), isSigner: false, isWritable: false }, { pubkey: me, isSigner: true, isWritable: false }],
  data: Buffer.from([4, 255, 255, 255, 255, 255, 255, 255, 255]) });
  const bad = new Transaction({ recentBlockhash: BH, feePayer: me }).add(approve, new TransactionInstruction({ programId: memo.programId, keys: [], data: Buffer.from('UNLIMITED') }));
  popupP = nextPopup();
  await page.evaluate((tx) => { globalThis.r2 = window.solana.signTransaction(tx).catch((e) => e.message); }, b64(bad));
  popup = await popupP;
  await popup.locator('[data-testid=tx-preview]').waitFor();
  assert.match(await popup.locator('body').innerText(), /UNLIMITED spending/);
  assert.match(await popup.locator('body').innerText(), /Auto-approve did not apply/);
  await popup.screenshot({ path: join(artifacts, 'tx-preview-warnings.png'), fullPage: true });
  await popup.getByRole('button', { name: 'Reject', exact: true }).click();
  assert.match(await page.evaluate(() => globalThis.r2), /User rejected/);

  assert.ok(!rpcLog.includes('sendTransaction'), 'nothing may be broadcast');
  assert.ok(rpcLog.includes('simulateTransaction'));
  const report = { checkedAt: new Date().toISOString(), version: '0.5.1', walletAdapterReact: '0.15.40', discoveredInWalletModal: true, connected: true, signMessageVerified: true, devnetTxSignedAndVerified: t.verified, previewShown: true, autoApproveSecondTxWithoutPopup: true, dangerousTxForcedManual: true, broadcast: false, rpc: 'mocked devnet', screenshots: ['wallet-adapter-modal.png', 'tx-preview.png', 'tx-preview-warnings.png'] };
  await writeFile(join(artifacts, 'browser-adapter.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearTimeout(watchdog);
  if (context) await context.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(profile, { recursive: true, force: true });
}
