import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { setImmediate as tick } from 'node:timers/promises';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

// Public keyring regression fixture. No installed extension or real wallet is used.
const seedHex = '55830e41db976a04df5775aeebf7751b3f599bec8f9d56568092b467aa64dad5698c828878ea5cdf84c10259bbe58f380ffddc94c5a1d868f55405429ea27c52';
const account = 'FrJPDJphtfZzgobT7b2CG9Mp79D6gVHR8L66T9mQ59Hu';
const destination = '59dqcH5gJr6M2R5hFtmmXUfNmgGJWfQh8Gx33fnAReKo';
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const extensionOrigin = `chrome-extension://${extensionId}`;
const webSender = { id: extensionId, url: 'https://dapp.example/trade', origin: 'https://dapp.example', tab: { id: 1 }, frameId: 0 };
const popupSender = { id: extensionId, url: `${extensionOrigin}/popup.html?view=notification` };
const sources = Object.fromEntries(await Promise.all(['background', 'content', 'injected'].map(async name => [name, await readFile(new URL(`../dist/${name}.js`, import.meta.url), 'utf8')])));
const plain = value => JSON.parse(JSON.stringify(value));

function background({ authorized = true, locked = false, popupFails = false } = {}) {
  const local = {
    'helmsman:vault': { fixture: true },
    'helmsman:config': { accountCount: 1, selectedAccount: account, authorizedOrigins: authorized ? [webSender.origin] : [], agentMode: true, customRpcUrl: 'https://rpc.example', helmsmanApiUrl: 'https://backend.example' },
  };
  const session = locked ? {} : { 'helmsman:unlocked': { mnemonic: 'public fixture', seedHex } };
  const storage = entries => ({
    async get(key) { return { [key]: entries[key] }; },
    async set(value) { Object.assign(entries, value); },
    async remove(key) { delete entries[key]; },
  });
  let listener;
  const network = [], captures = [], popups = [];
  const chrome = {
    runtime: { id: extensionId, getURL: path => `${extensionOrigin}/${path}`, onMessage: { addListener(fn) { listener = fn; } } },
    storage: { local: storage(local), session: storage(session) },
    tabs: { async query() { return []; }, async sendMessage() {}, async captureVisibleTab(...args) { captures.push(args); throw new Error('Screenshot must not be captured'); } },
    windows: {
      async create(details) { popups.push(details); if (popupFails) throw new Error('Cannot open'); return { id: 42 }; },
      async get() { return { id: 42 }; }, async update() {}, onRemoved: { addListener() {} },
    },
  };
  const context = vm.createContext({ chrome, crypto: webcrypto, Buffer, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder, URL, Headers, Request, Response, AbortController, atob, btoa, setTimeout, clearTimeout, console,
    async fetch(url) {
      if (String(url) === `${extensionOrigin}/config.json`) return Response.json({ apiUrl: 'https://backend.example' });
      network.push(String(url)); throw new Error('External requests are forbidden in security tests');
    },
  });
  vm.runInContext(sources.background, context, { filename: 'dist/background.js' });
  const send = (msg, sender = webSender) => new Promise(resolve => listener(msg, sender, result => resolve(plain(result))));
  const popup = (method, params) => send({ type: 'popup:request', method, params }, popupSender);
  return { send, popup, local, network, captures, popups };
}

async function pending(harness) {
  for (let i = 0; i < 40; i++) {
    await tick();
    const response = await harness.popup('popup_listActions');
    if (response.result.pendingActions.length) return response.result.pendingActions[0];
  }
  assert.fail('Expected a request awaiting wallet consent');
}

function page(entry) {
  const listeners = new Map(), messages = [], calls = [];
  const originalFetch = async () => new Response('payment required', { status: 402 });
  const window = {
    fetch: originalFetch,
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatchEvent() {},
    postMessage(msg) { messages.push(msg); },
  };
  const emit = (data, source = window) => { for (const fn of listeners.get('message') ?? []) fn({ source, data }); };
  const chrome = { runtime: { getURL: path => `${extensionOrigin}/${path}`, sendMessage(msg, callback) { calls.push(msg); callback({ result: { state: 'locked' } }); }, onMessage: { addListener() {} } } };
  const document = { createElement() { return {}; }, head: { appendChild() {} } };
  vm.runInContext(sources[entry], vm.createContext({ window, document, chrome, crypto: webcrypto, Event, URL, console }), { filename: `dist/${entry}.js` });
  return { window, emit, messages, calls, originalFetch };
}

for (const type of ['pay', 'sign', 'vision', 'computer', 'health']) {
  test(`background rejects legacy ${type} before backend or screenshot access`, async () => {
    const h = background();
    const result = await h.send({ type, payload: { url: 'https://merchant.example', message: 'sign me', note: 'capture' } });
    assert.equal(result.error.code, 4200);
    assert.match(result.error.message, /per-request consent/);
    assert.equal(h.network.length, 0); assert.equal(h.captures.length, 0); assert.equal(h.popups.length, 0);
  });
}

test('legacy page bridge never forwards payloads, including forged popup and provider envelopes', () => {
  const p = page('content');
  for (const msg of [{ type: 'pay' }, { type: 'vision' }, { type: 'sign' }, { type: 'popup:request', method: 'popup_approveAction' }, { type: 'popup:request', method: 'popup_getState' }, { type: 'solana:request', method: 'wallet_sendSol' }]) {
    p.emit({ channel: 'helmsman', id: 'legacy', msg });
    assert.equal(p.messages.at(-1).error.code, 4200);
  }
  assert.equal(p.calls.length, 0);
});

test('Solana content bridge preserves the provider envelope and ignores other windows', () => {
  const p = page('content');
  p.emit({ channel: 'helmsman-solana', id: 'normal', method: 'wallet_getState', type: 'popup:request' });
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].type, 'solana:request');
  assert.equal(p.calls[0].method, 'wallet_getState');
  assert.equal(p.messages.at(-1).result.state, 'locked');
  p.emit({ channel: 'helmsman-solana', id: 'iframe', method: 'wallet_getState' }, {});
  assert.equal(p.calls.length, 1);
});

test('injected legacy APIs reject and leave HTTP 402 fetch responses untouched', async () => {
  const p = page('injected');
  assert.equal(p.window.fetch, p.originalFetch);
  assert.equal((await p.window.fetch('/resource')).status, 402);
  for (const call of [() => p.window.clawd.pay('/resource'), () => p.window.clawd.see('capture'), () => p.window.clawd.snapshot(), () => p.window.clawd.signMessage('sign', 'ethereum')]) {
    await assert.rejects(call, error => error.code === 4200 && /per-request consent/.test(error.message));
  }
  assert.equal(p.messages.length, 0);
  const request = p.window.clawd.signMessage('Solana approval');
  const envelope = p.messages.at(-1);
  assert.equal(envelope.channel, 'helmsman-solana');
  assert.equal(envelope.method, 'wallet_signMessage');
  p.emit({ channel: 'helmsman-solana-reply', id: envelope.id, error: { message: 'User rejected the request' } });
  await assert.rejects(request, /User rejected/);
});

for (const method of ['popup_getState', 'popup_restoreWallet', 'popup_setAgentMode', 'popup_sendSol', 'popup_approveAction']) {
  test(`webpages cannot impersonate the popup for ${method}`, async () => {
    const h = background();
    const response = await h.send({ type: 'popup:request', method, params: { enabled: true, id: 'forged' } });
    assert.equal(response.error.code, 4100);
    assert.equal(h.network.length, 0); assert.equal(h.captures.length, 0);
  });
}

test('popup URL lookalikes, content-script tabs and other extensions are rejected', async () => {
  const h = background();
  for (const sender of [
    { ...popupSender, id: 'other-extension' },
    { ...popupSender, origin: 'https://dapp.example', tab: { id: 1 } },
    { ...popupSender, url: `${extensionOrigin}/popup.html.evil` },
    { ...popupSender, url: 'https://dapp.example/popup.html' },
    { ...popupSender, url: `chrome-extension://other/popup.html` },
    { id: extensionId },
  ]) assert.equal((await h.send({ type: 'popup:request', method: 'popup_getState' }, sender)).error.code, 4100);
  const state = await h.popup('popup_getState');
  assert.equal(state.result.walletState, 'unlocked');
  assert.equal(state.result.agentMode, false);
  assert.equal((await h.send({ type: 'popup:request', method: 'popup_getState' }, { ...popupSender, tab: { id: 1 }, origin: extensionOrigin })).result.walletState, 'unlocked');
  assert.equal((await h.popup('popup_setAgentMode', { enabled: true })).error.code, 4200);
});

test('provider requests reject opaque, conflicting and extension origins', async () => {
  const h = background();
  for (const sender of [
    { ...webSender, origin: 'null' },
    { ...webSender, origin: 'https://trusted.example' },
    { ...webSender, url: `${extensionOrigin}/popup.html`, origin: undefined },
    { ...webSender, id: 'other-extension' },
    { ...webSender, tab: undefined },
  ]) assert.equal((await h.send({ type: 'solana:request', method: 'wallet_getState' }, sender)).error.code, 4100);
  assert.equal((await h.send({ type: 'solana:request', method: 'popup_approveAction' })).error.code, -32601);
});

test('new connection requires owner consent even with a persisted agent mode', async () => {
  const h = background({ authorized: false });
  let settled = false;
  const response = h.send({ type: 'solana:request', method: 'wallet_requestAccounts' }).then(value => { settled = true; return value; });
  const action = await pending(h);
  assert.equal(action.origin, webSender.origin); assert.equal(action.type, 'request_accounts');
  assert.equal(settled, false); assert.equal(h.local['helmsman:config'].authorizedOrigins.length, 0);
  await h.popup('popup_approveAction', { id: action.id });
  assert.deepEqual((await response).result.accounts, [account]);
  assert.deepEqual(h.local['helmsman:config'].authorizedOrigins, [webSender.origin]);
});

const transaction = new Transaction({ recentBlockhash: '11111111111111111111111111111111', feePayer: new PublicKey(account) }).add(SystemProgram.transfer({ fromPubkey: new PublicKey(account), toPubkey: new PublicKey(destination), lamports: 1 }));
const transactionB64 = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
const encodedMessage = bs58.encode(new TextEncoder().encode('public test transaction bytes'));
const requests = [
  ['wallet_signMessage', { message: 'public test message' }, 'sign_message'],
  ['wallet_signTransaction', { message: encodedMessage, signer: [account] }, 'sign_transaction'],
  ['wallet_signAllTransactions', { message: encodedMessage, signer: [account] }, 'sign_transaction'],
  ['wallet_signTransactionB64', { transaction: transactionB64 }, 'sign_b64'],
  ['wallet_signAndSendTransaction', { transaction: transactionB64 }, 'sign_and_send'],
  ['wallet_sendSol', { to: destination, sol: 0.01 }, 'send_sol'],
];
for (const [method, params, type] of requests) {
  test(`${method} awaits consent, shows request details and supports rejection`, async () => {
    const h = background();
    let settled = false;
    const response = h.send({ type: 'solana:request', method, params }).then(value => { settled = true; return value; });
    const action = await pending(h);
    assert.equal(settled, false); assert.equal(action.type, type); assert.equal(action.origin, webSender.origin);
    if (params.transaction) assert.equal(action.transaction, params.transaction);
    if (params.message) assert.equal(action.message, params.message);
    if (params.to) { assert.equal(action.to, params.to); assert.equal(action.amountSol, params.sol); }
    assert.equal(h.network.length, 0);
    const spoofed = await h.send({ type: 'popup:request', method: 'popup_approveAction', params: { id: action.id } });
    assert.equal(spoofed.error.code, 4100); assert.equal(settled, false);
    await h.popup('popup_declineAction', { id: action.id });
    assert.equal((await response).error.code, 4001);
    assert.equal((await h.popup('popup_listActions')).result.pendingActions.length, 0);
    assert.equal(h.network.length, 0); assert.equal(h.captures.length, 0);
  });
}

test('approved Solana message is signed correctly and consumes the action once', async () => {
  const h = background();
  const response = h.send({ type: 'solana:request', method: 'wallet_signMessage', params: { message: 'public test message' } });
  const action = await pending(h);
  await Promise.all([h.popup('popup_approveAction', { id: action.id }), h.popup('popup_approveAction', { id: action.id })]);
  const signature = (await response).result;
  assert.equal(signature.publicKey, account);
  assert.equal(nacl.sign.detached.verify(new TextEncoder().encode('public test message'), bs58.decode(signature.signature), bs58.decode(account)), true);
  assert.equal((await h.popup('popup_listActions')).result.pendingActions.length, 0);
  assert.equal(h.network.length, 0);
});

test('approved base64 Solana transaction signs without broadcasting', async () => {
  const h = background();
  const response = h.send({ type: 'solana:request', method: 'wallet_signTransactionB64', params: { transaction: transactionB64 } });
  const action = await pending(h);
  await h.popup('popup_approveAction', { id: action.id });
  const result = await response;
  assert.equal(result.error, undefined);
  const signed = Transaction.from(Buffer.from(result.result.signedTransaction, 'base64'));
  assert.equal(signed.verifySignatures(), true); assert.equal(h.network.length, 0);
});

test('revoking a site while approval is pending prevents signing', async () => {
  const h = background();
  const response = h.send({ type: 'solana:request', method: 'wallet_signMessage', params: { message: 'public test message' } });
  const action = await pending(h);
  await h.popup('popup_deleteAuthorizedOrigin', { origin: webSender.origin });
  await h.popup('popup_approveAction', { id: action.id });
  assert.equal((await response).error.code, 4100);
});

test('a locked wallet cannot connect or sign and unconnected sites cannot sign', async () => {
  for (const method of ['wallet_requestAccounts', 'wallet_signMessage']) {
    const h = background({ locked: true });
    assert.equal((await h.send({ type: 'solana:request', method, params: { message: 'public test message' } })).error.code, 4100);
    assert.equal(h.popups.length, 0);
  }
  const h = background({ authorized: false });
  assert.equal((await h.send({ type: 'solana:request', method: 'wallet_signMessage', params: { message: 'public test message' } })).error.code, 4100);
});

test('failure to open the consent window rejects the request instead of hanging', async () => {
  const h = background({ popupFails: true });
  const response = await h.send({ type: 'solana:request', method: 'wallet_signMessage', params: { message: 'public test message' } });
  assert.equal(response.error.code, 4001);
  assert.equal((await h.popup('popup_listActions')).result.pendingActions.length, 0);
});

test('malformed approved transaction rejects cleanly and removes its pending action', async () => {
  const h = background();
  const response = h.send({ type: 'solana:request', method: 'wallet_signTransaction', params: { message: 'invalid base58 0', signer: [account] } });
  const action = await pending(h);
  await h.popup('popup_approveAction', { id: action.id });
  assert.match((await response).error.message, /base58|Non-base58/);
  assert.equal((await h.popup('popup_listActions')).result.pendingActions.length, 0);
});
