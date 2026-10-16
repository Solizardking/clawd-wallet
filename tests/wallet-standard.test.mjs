import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import bs58 from 'bs58';

// Loads the built MAIN-world script into a fake page and drives it like a dApp
// would through the Wallet Standard. Replies emulate the content-script bridge;
// no extension, key, RPC or network is involved.
const source = await readFile(new URL('../dist/injected.js', import.meta.url), 'utf8');
const ORIGIN = 'https://dapp.example';
const account = 'FrJPDJphtfZzgobT7b2CG9Mp79D6gVHR8L66T9mQ59Hu';
const sig = bs58.encode(new Uint8Array(64).fill(7));

class DetailEvent extends Event { constructor(type, detail) { super(type); this.detail = detail; } }

function load({ before = true, handler } = {}) {
  const win = new EventTarget();
  const posted = [];
  const deliver = (data, origin = ORIGIN, source = win) => {
    const ev = new Event('message');
    Object.defineProperties(ev, { data: { value: data }, origin: { value: origin }, source: { value: source } });
    win.dispatchEvent(ev);
  };
  win.location = { origin: ORIGIN, host: 'dapp.example' };
  win.postMessage = (msg) => {
    posted.push(msg);
    if (msg.channel !== 'helmsman-solana') return;
    queueMicrotask(async () => {
      try { deliver({ channel: 'helmsman-solana-reply', id: msg.id, result: await handler(msg) }); }
      catch (e) { deliver({ channel: 'helmsman-solana-reply', id: msg.id, error: { message: e.message } }); }
    });
  };
  const wallets = [];
  const api = { register: (...ws) => { wallets.push(...ws); return () => {}; } };
  if (before) win.addEventListener('wallet-standard:register-wallet', (e) => e.detail(api));
  const ctx = vm.createContext({ window: win, crypto: webcrypto, Event, TextEncoder, TextDecoder, atob, btoa, console, URL, queueMicrotask, location: win.location });

  vm.runInContext(source, ctx, { filename: 'dist/injected.js' });
  if (!before) win.dispatchEvent(new DetailEvent('wallet-standard:app-ready', api));
  return { win, ctx, wallets, posted, deliver };
}

const defaultHandler = (calls) => { let authorized = false; return async (msg) => {
  calls.push(msg);
  switch (msg.method) {
    case 'wallet_requestAccounts':
      if (msg.params?.promptAuthorization === false && !authorized) throw new Error('Unauthorized. Request permissions first.');
      return { accounts: [account] };
    case 'wallet_signMessage': return { publicKey: account, signature: sig };
    case 'wallet_signTransactionB64': return { signedTransaction: btoa('signed:' + atob(msg.params.transaction)) };
    case 'wallet_getCluster': return { title: 'Devnet', cluster: 'devnet' };
    case 'wallet_signAndSendTransaction': return { signature: sig };
    case 'wallet_signAllTransactionsB64': return { signedTransactions: msg.params.transactions.map((t) => btoa('signed:' + atob(t))) };
    case 'wallet_signIn': authorized = true; return { address: account, signedMessageB64: btoa('dapp.example wants you to sign in with your Solana account:\n' + account + '\n\nNonce: ' + msg.params.input.nonce), signature: sig };
    case 'wallet_disconnect': return { ok: true };
    default: throw new Error('unexpected ' + msg.method);
  }
}; };

test('registers "Clawd Wallet" via register-wallet event (wallet loads after app)', () => {
  const { wallets } = load({ handler: defaultHandler([]) });
  assert.equal(wallets.length, 1);
  const w = wallets[0];
  assert.equal(w.name, 'Clawd Wallet');
  assert.equal(w.version, '1.0.0');
  assert.match(w.icon, /^data:image\/png;base64,iVBOR/);
  assert.deepEqual([...w.chains], ['solana:mainnet', 'solana:devnet', 'solana:testnet']);
  assert.ok(!w.chains.some((c) => /clawd/i.test(c)), 'Clawd Chain must not be advertised');
  assert.deepEqual(Object.keys(w.features).sort(), [
    'solana:signAndSendTransaction', 'solana:signIn', 'solana:signMessage', 'solana:signTransaction',
    'standard:connect', 'standard:disconnect', 'standard:events',
  ]);
  assert.deepEqual([...w.features['solana:signTransaction'].supportedTransactionVersions], ['legacy', 0]);
});

test('registers via app-ready event too (wallet loads before app)', () => {
  const { wallets } = load({ before: false, handler: defaultHandler([]) });
  assert.equal(wallets.length, 1);
  assert.equal(wallets[0].name, 'Clawd Wallet');
});

test('legacy providers stay and do not impersonate Phantom or leak a version', () => {
  const { win } = load({ handler: defaultHandler([]) });
  assert.ok(win.solana && win.clawd && win.helmsman);
  assert.equal(win.solana.isPhantom, undefined);
  assert.equal(win.clawd.version, undefined);
  assert.equal(win.phantom, undefined);
});

test('no accounts and no bridge traffic before connect', () => {
  const { wallets, posted } = load({ handler: defaultHandler([]) });
  assert.equal(wallets[0].accounts.length, 0);
  assert.equal(posted.length, 0, 'registration must not message the wallet');
});

test('silent connect maps to promptAuthorization:false and fails for unapproved origins', async () => {
  const calls = [];
  const { wallets } = load({ handler: defaultHandler(calls) });
  await assert.rejects(wallets[0].features['standard:connect'].connect({ silent: true }), /Unauthorized/);
  assert.equal(calls[0].params.promptAuthorization, false);
  assert.equal(wallets[0].accounts.length, 0);
});

test('connect -> change event -> sign/send map onto consent-gated provider methods', async () => {
  const calls = [];
  const { wallets } = load({ handler: defaultHandler(calls) });
  const w = wallets[0];
  const changes = [];
  const off = w.features['standard:events'].on('change', (p) => changes.push(p));
  const { accounts } = await w.features['standard:connect'].connect();
  assert.equal(calls.at(-1).method, 'wallet_requestAccounts');
  assert.equal(calls.at(-1).params.promptAuthorization, true);
  assert.equal(accounts[0].address, account);
  assert.deepEqual([...accounts[0].publicKey], [...bs58.decode(account)]);
  assert.equal(changes.length, 1);

  const msg = new TextEncoder().encode('hello clawd');
  const [m] = await w.features['solana:signMessage'].signMessage({ account: accounts[0], message: msg });
  assert.equal(calls.at(-1).method, 'wallet_signMessage');
  assert.equal(atob(calls.at(-1).params.messageB64), 'hello clawd');
  assert.equal(calls.at(-1).params.signer, account);
  // arbitrary (non-UTF-8) bytes are forwarded too
  await w.features['solana:signMessage'].signMessage({ account: accounts[0], message: new Uint8Array([0xff, 0x00, 0xfe]) });
  assert.deepEqual([...atob(calls.at(-1).params.messageB64)].map((c) => c.charCodeAt(0)), [0xff, 0x00, 0xfe]);
  assert.deepEqual([...m.signature], [...bs58.decode(sig)]);

  const tx = new Uint8Array([1, 2, 3]);
  const [t] = await w.features['solana:signTransaction'].signTransaction({ account: accounts[0], transaction: tx, chain: 'solana:devnet' });
  assert.equal(calls.at(-1).method, 'wallet_signTransactionB64');
  assert.equal(new TextDecoder().decode(t.signedTransaction), 'signed:\x01\x02\x03');

  await assert.rejects(w.features['solana:signAndSendTransaction'].signAndSendTransaction({ account: accounts[0], transaction: tx, chain: 'solana:mainnet' }), /Switch network/);
  assert.notEqual(calls.at(-1).method, 'wallet_signAndSendTransaction', 'chain mismatch must not reach signing');
  const [s] = await w.features['solana:signAndSendTransaction'].signAndSendTransaction({ account: accounts[0], transaction: tx, chain: 'solana:devnet', options: { skipPreflight: true, preflightCommitment: 'processed', maxRetries: 3, minContextSlot: 7, commitment: 'confirmed' } });
  assert.equal(calls.at(-1).method, 'wallet_signAndSendTransaction');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).params.options)), { skipPreflight: true, preflightCommitment: 'processed', maxRetries: 3, minContextSlot: 7, commitment: 'confirmed' });

  // several inputs = one batched signAllTransactions approval
  const outs = await w.features['solana:signTransaction'].signTransaction(
    { account: accounts[0], transaction: new Uint8Array([4]), chain: 'solana:devnet' },
    { account: accounts[0], transaction: new Uint8Array([5]), chain: 'solana:devnet' });
  assert.equal(calls.at(-1).method, 'wallet_signAllTransactionsB64');
  assert.equal(calls.at(-1).params.transactions.length, 2);
  assert.deepEqual([...outs].map((o) => new TextDecoder().decode(o.signedTransaction)), ['signed:\x04', 'signed:\x05']);
  assert.deepEqual([...s.signature], [...bs58.decode(sig)]);

  await assert.rejects(w.features['solana:signTransaction'].signTransaction({ account: accounts[0], transaction: tx, chain: 'clawd:mainnet' }), /Unsupported chain/);
  await assert.rejects(w.features['solana:signMessage'].signMessage({ account: { address: 'x' }, message: msg }), /not connected/);

  await w.features['standard:disconnect'].disconnect();
  assert.equal(calls.at(-1).method, 'wallet_disconnect');
  assert.equal(w.accounts.length, 0);
  assert.equal(changes.length, 2);
  off();
});

test('signIn forwards the full SIWS input to the wallet (which builds and checks it)', async () => {
  const calls = [];
  const { wallets } = load({ handler: defaultHandler(calls) });
  const input = { domain: 'dapp.example', statement: 'Sign in to test', nonce: 'abc12345', uri: 'https://dapp.example/login', version: '1', chainId: 'solana:devnet', issuedAt: '2026-10-16T17:00:00Z', resources: ['https://dapp.example/tos'] };
  const [out] = await wallets[0].features['solana:signIn'].signIn(input);
  const signInCall = calls.find((c) => c.method === 'wallet_signIn');
  assert.deepEqual(JSON.parse(JSON.stringify(signInCall.params.input)), input);
  assert.match(new TextDecoder().decode(out.signedMessage), /Nonce: abc12345/);
  assert.equal(out.account.address, account);
  assert.deepEqual([...out.signature], [...bs58.decode(sig)]);
});

test('bridge ignores replies/events from other origins or windows', async () => {
  const { wallets, deliver } = load({ handler: defaultHandler([]) });
  await wallets[0].features['standard:connect'].connect();
  deliver({ channel: 'helmsman-solana-event', event: 'disconnected' }, 'https://evil.example');
  deliver({ channel: 'helmsman-solana-event', event: 'disconnected' }, ORIGIN, {});
  assert.equal(wallets[0].accounts.length, 1);
  deliver({ channel: 'helmsman-solana-event', event: 'disconnected' });
  assert.equal(wallets[0].accounts.length, 0);
});

test('injected script leaks no top-level globals into the page', () => {
  const { ctx } = load({ handler: defaultHandler([]) });
  const own = Object.getOwnPropertyNames(ctx).filter((k) => !['window', 'crypto', 'Event', 'TextEncoder', 'TextDecoder', 'atob', 'btoa', 'console', 'URL', 'queueMicrotask', 'location'].includes(k));
  assert.deepEqual(own, []);
});
