import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Wallet Standard shape/compliance checks against the built MAIN-world script
// (wallet-standard WALLET.md + @wallet-standard/base + @solana/wallet-standard-features),
// plus the injection-conflict regression (another wallet owns window.solana).
// Self-checks only; this is not an official certification.
const source = await readFile(new URL('../dist/injected.js', import.meta.url), 'utf8');
const ORIGIN = 'https://dapp.example';
const account = 'FrJPDJphtfZzgobT7b2CG9Mp79D6gVHR8L66T9mQ59Hu';
class DetailEvent extends Event { constructor(t, d) { super(t); this.detail = d; } }

function makeWin(setup) {
  const win = new EventTarget();
  win.location = { origin: ORIGIN, host: 'dapp.example' };
  win.postMessage = (msg) => {
    if (msg.channel !== 'helmsman-solana') return;
    queueMicrotask(() => {
      const ev = new Event('message');
      const result = msg.method === 'wallet_requestAccounts' ? { accounts: [account] } : { ok: true };
      Object.defineProperties(ev, { data: { value: { channel: 'helmsman-solana-reply', id: msg.id, result } }, origin: { value: ORIGIN }, source: { value: win } });
      win.dispatchEvent(ev);
    });
  };
  setup?.(win);
  const wallets = []; const warnings = [];
  const api = { register: (...ws) => { wallets.push(...ws); return () => {}; } };
  win.addEventListener('wallet-standard:register-wallet', (e) => e.detail(api));
  const con = { ...console, warn: (...a) => warnings.push(a.join(' ')) };
  const ctx = vm.createContext({ window: win, crypto: webcrypto, Event, TextEncoder, TextDecoder, atob, btoa, console: con, URL, queueMicrotask, location: win.location });
  const run = () => vm.runInContext(source, ctx, { filename: 'dist/injected.js' });
  return { win, wallets, warnings, run, api };
}

test('Wallet shape: version, name, data-URI icon (svg/webp/png/gif, small), chains', () => {
  const { wallets, run } = makeWin(); run();
  const [w] = wallets;
  assert.equal(w.version, '1.0.0');
  assert.equal(typeof w.name, 'string'); assert.ok(w.name.length);
  assert.match(w.icon, /^data:image\/(svg\+xml|webp|png|gif);base64,/);
  assert.ok(w.icon.length < 10_000, `icon is ${w.icon.length} chars`);
  for (const c of w.chains) assert.match(c, /^solana:(mainnet|devnet|testnet)$/);
  w.chains.push('evil:chain');
  assert.ok(!w.chains.includes('evil:chain'), 'chains must be a copy');
  assert.equal(w.accounts.length, 0);
});

test('Features: required standard + solana features with versions and methods', () => {
  const { wallets, run } = makeWin(); run();
  const f = wallets[0].features;
  const need = {
    'standard:connect': 'connect', 'standard:disconnect': 'disconnect', 'standard:events': 'on',
    'solana:signAndSendTransaction': 'signAndSendTransaction', 'solana:signTransaction': 'signTransaction',
    'solana:signMessage': 'signMessage', 'solana:signIn': 'signIn',
  };
  for (const [name, method] of Object.entries(need)) {
    assert.ok(f[name], name);
    assert.equal(f[name].version, '1.0.0', `${name} version`);
    assert.equal(typeof f[name][method], 'function', `${name}.${method}`);
  }
  for (const k of ['solana:signAndSendTransaction', 'solana:signTransaction']) assert.deepEqual([...f[k].supportedTransactionVersions], ['legacy', 0]);
  for (const k of Object.keys(f)) assert.match(k, /^[a-z]+:[A-Za-z]+$/, 'features are namespaced');
});

test('Accounts: read-only WalletAccount, copies, account features subset of wallet features', async () => {
  const { wallets, run } = makeWin(); run();
  const w = wallets[0];
  const changes = [];
  w.features['standard:events'].on('change', (p) => changes.push(Object.keys(p)));
  const { accounts } = await w.features['standard:connect'].connect();
  const a = accounts[0];
  assert.equal(a.address, account);
  assert.ok(a.publicKey instanceof Uint8Array || a.publicKey.constructor.name === 'Uint8Array');
  assert.equal(a.publicKey.length, 32);
  const k0 = a.publicKey[0]; const pk = a.publicKey; pk[0] ^= 0xff;
  assert.equal(a.publicKey[0], k0, "publicKey getter returns a copy");
  assert.ok(Object.isFrozen(a), 'account object is frozen');
  assert.throws(() => { 'use strict'; a.address = 'x'; });
  for (const c of a.chains) assert.ok(w.chains.includes(c));
  for (const feat of a.features) assert.ok(feat in w.features, feat);
  // standard:events change carries only changed properties
  assert.deepEqual(changes, [['accounts']]);
  await w.features['standard:connect'].connect();
  assert.equal(changes.length, 1, 'no change event when accounts are unchanged');
  await w.features['standard:disconnect'].disconnect();
  assert.equal(w.accounts.length, 0);
  assert.deepEqual(changes.at(-1), ['accounts']);
});

test('clawd:capabilities is read-only, promptless and matches preview blocking rules', async () => {
  const { wallets, run } = makeWin(); run();
  const cap = await wallets[0].features['clawd:capabilities'].getCapabilities();
  assert.equal(cap.humanApprovalRequired, true);
  assert.equal(cap.silentSigning, false);
  assert.ok(Object.isFrozen(cap));
  const preview = await readFile(new URL('../src/tx/preview.ts', import.meta.url), 'utf8');
  const blocking = [...preview.match(/const BLOCKING = new Set\(\[([\s\S]*?)\]\)/)[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual([...cap.riskWarnings].sort(), blocking);
});

test('conflict: another wallet owns window.solana (non-configurable) -> no throw, not clobbered, still registers', () => {
  const phantom = { isPhantom: true };
  const { win, wallets, warnings, run } = makeWin((w) => Object.defineProperty(w, 'solana', { value: phantom, writable: false, configurable: false }));
  assert.doesNotThrow(run);
  assert.equal(win.solana, phantom);
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].name, 'Clawd Wallet');
  assert.ok(win.clawd?.isClawd);
  assert.ok(warnings.some((w) => /window\.solana/.test(w)));
});

test('conflict: window.solana set by a configurable/writable wallet is left alone', () => {
  const other = { isBackpack: true };
  const { win, wallets, run } = makeWin((w) => { w.solana = other; });
  assert.doesNotThrow(run);
  assert.equal(win.solana, other);
  assert.equal(wallets.length, 1);
});

test('double injection registers once and does not throw', () => {
  const { wallets, run } = makeWin();
  run(); assert.doesNotThrow(run);
  assert.equal(wallets.length, 1);
});
