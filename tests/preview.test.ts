// Unit tests for the transaction preview, auto-approve rules and SIWS checks.
// Runs with `node --import tsx --test`. Fake RPC only: no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AddressLookupTableAccount, ComputeBudgetProgram, Keypair, NONCE_ACCOUNT_LENGTH, PublicKey, SystemProgram,
  Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { previewTransaction, formatUnits, type PreviewRpc } from "../src/tx/preview.ts";
import { TOKEN, TOKEN_2022, U64_MAX } from "../src/tx/programs.ts";
import { checkAutoApprove, createSession } from "../src/tx/auto-approve.ts";
import { buildSignInMessage, checkSignIn } from "../src/tx/siws.ts";

const user = Keypair.fromSeed(new Uint8Array(32).fill(1));
const other = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey;
const me = user.publicKey.toBase58();
const BH = "11111111111111111111111111111111";
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
void NONCE_ACCOUNT_LENGTH;

type Acc = { lamports: number; owner: string; data?: Uint8Array };
function fakeRpc(opts: { pre?: Record<string, Acc>; post?: Record<string, Acc>; err?: unknown; throwSim?: boolean; tables?: AddressLookupTableAccount[]; mints?: Record<string, { decimals: number }> } = {}): PreviewRpc & { simCalls: unknown[] } {
  const simCalls: unknown[] = [];
  const info = (a?: Acc) => a ? { lamports: a.lamports, owner: new PublicKey(a.owner), data: Buffer.from(a.data ?? new Uint8Array()), executable: false, rentEpoch: 0 } : null;
  return {
    simCalls,
    async getAddressLookupTable(key: PublicKey) {
      return { context: { slot: 1 }, value: opts.tables?.find((t) => t.key.equals(key)) ?? null };
    },
    async getMultipleAccountsInfo(pks: PublicKey[]) { return pks.map((p) => info(opts.pre?.[p.toBase58()])); },
    async getMultipleParsedAccounts(pks: PublicKey[]) {
      return { context: { slot: 1 }, value: pks.map((p) => { const m = opts.mints?.[p.toBase58()]; return m ? { lamports: 1, owner: new PublicKey(TOKEN), executable: false, rentEpoch: 0, data: { program: "spl-token", parsed: { type: "mint", info: { decimals: m.decimals } }, space: 82 } } : null; }) };
    },
    async simulateTransaction(tx: VersionedTransaction, cfg: { accounts: { addresses: string[] } }) {
      simCalls.push(cfg);
      if (opts.throwSim) throw new Error("RPC down");
      return { context: { slot: 1 }, value: {
        err: opts.err ?? null, logs: ["Program log: ok"], unitsConsumed: 1234, returnData: null,
        accounts: cfg.accounts.addresses.map((a) => { const p = opts.post?.[a] ?? opts.pre?.[a]; return p ? { lamports: p.lamports, owner: p.owner, data: [Buffer.from(p.data ?? new Uint8Array()).toString("base64"), "base64"], executable: false, rentEpoch: 0 } : null; }),
      } };
    },
    async getFeeForMessage() { return { context: { slot: 1 }, value: 5000 }; },
  } as unknown as PreviewRpc & { simCalls: unknown[] };
}

function legacy(...ixs: TransactionInstruction[]): Uint8Array {
  const tx = new Transaction({ recentBlockhash: BH, feePayer: user.publicKey }).add(...ixs);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

function tokenAccount(mint: PublicKey, owner: PublicKey, amount: bigint, delegate?: PublicKey, delegated = 0n): Uint8Array {
  const d = new Uint8Array(165);
  d.set(mint.toBytes(), 0); d.set(owner.toBytes(), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  if (delegate) { d[72] = 1; d.set(delegate.toBytes(), 76); new DataView(d.buffer).setBigUint64(121, delegated, true); }
  d[108] = 1;
  return d;
}

test("legacy SOL transfer: programs, fees, simulated SOL change, no blockers", async () => {
  const raw = legacy(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }),
    SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: other, lamports: 10_000_000 }),
  );
  const rpc = fakeRpc({ pre: { [me]: { lamports: 1_000_000_000, owner: BH } }, post: { [me]: { lamports: 989_995_000, owner: BH } } });
  const p = await previewTransaction(raw, [me], rpc);
  assert.equal(p.version, "legacy");
  assert.deepEqual(p.programs.map((x) => x.name), ["Compute Budget", "System Program"]);
  assert.equal(p.computeUnitLimit, 200_000);
  assert.equal(p.priorityFeeLamports, 200);
  assert.equal(p.feeLamports, 5000);
  assert.equal(p.baseFeeLamports, 4800);
  assert.ok(p.simulation.ok);
  assert.equal(p.balanceChanges[0].symbol, "SOL");
  assert.equal(p.balanceChanges[0].uiDelta, "-0.010005");
  assert.equal(p.solOutflowLamports, 10_005_000);
  assert.deepEqual(p.blocking, []);
  assert.match(p.instructions[2].summary, /Transfer 0.01 SOL/);
  const cfg = rpc.simCalls[0] as { sigVerify: boolean; replaceRecentBlockhash: boolean; accounts: { addresses: string[] } };
  assert.equal(cfg.sigVerify, false); assert.equal(cfg.replaceRecentBlockhash, true);
  assert.ok(cfg.accounts.addresses.includes(me));
});

test("v0 with address lookup table resolves accounts; unresolved table blocks", async () => {
  const tableKey = Keypair.generate().publicKey;
  const lutAddr = Keypair.generate().publicKey;
  const table = new AddressLookupTableAccount({ key: tableKey, state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [lutAddr] } });
  const msg = new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: BH, instructions: [SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: lutAddr, lamports: 1 })] }).compileToV0Message([table]);
  const raw = new VersionedTransaction(msg).serialize();
  const ok = await previewTransaction(raw, [me], fakeRpc({ tables: [table], pre: { [me]: { lamports: 10, owner: BH } } }));
  assert.equal(ok.version, 0);
  assert.ok(ok.writable.includes(lutAddr.toBase58()));
  assert.ok(ok.instructions[0].accounts.some((a) => a.address === lutAddr.toBase58() && a.writable));
  const bad = await previewTransaction(raw, [me], fakeRpc({ pre: { [me]: { lamports: 10, owner: BH } } }));
  assert.ok(bad.blocking.includes("lookup_unresolved"));
});

test("dangerous instructions are flagged and block auto-approve", async () => {
  const ta = Keypair.generate().publicKey;
  const approveMax = new TransactionInstruction({ programId: new PublicKey(TOKEN), keys: [{ pubkey: ta, isSigner: false, isWritable: true }, { pubkey: other, isSigner: false, isWritable: false }, { pubkey: user.publicKey, isSigner: true, isWritable: false }], data: Buffer.from([4, ...new Uint8Array(new BigUint64Array([U64_MAX]).buffer)]) });
  const approveSome = new TransactionInstruction({ ...approveMax, data: Buffer.from([4, 1, 0, 0, 0, 0, 0, 0, 0]) });
  const setAuth = new TransactionInstruction({ programId: new PublicKey(TOKEN_2022), keys: [{ pubkey: ta, isSigner: false, isWritable: true }, { pubkey: user.publicKey, isSigner: true, isWritable: false }], data: Buffer.from([6, 2, 1, ...other.toBytes()]) });
  const closeOther = new TransactionInstruction({ programId: new PublicKey(TOKEN), keys: [{ pubkey: ta, isSigner: false, isWritable: true }, { pubkey: other, isSigner: false, isWritable: true }, { pubkey: user.publicKey, isSigner: true, isWritable: false }], data: Buffer.from([9]) });
  const closeMine = new TransactionInstruction({ ...closeOther, keys: [{ pubkey: ta, isSigner: false, isWritable: true }, { pubkey: user.publicKey, isSigner: true, isWritable: true }] });
  const assign = SystemProgram.assign({ accountPubkey: user.publicKey, programId: other });
  const nonce = SystemProgram.nonceAdvance({ noncePubkey: Keypair.generate().publicKey, authorizedPubkey: user.publicKey });
  const unknown = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [], data: Buffer.from([1, 2]) });
  const cases: [TransactionInstruction[], string][] = [
    [[approveMax], "unlimited_approve"], [[approveSome], "token_approve"], [[setAuth], "set_authority"],
    [[closeOther], "close_to_other"], [[assign], "assign"], [[nonce, SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: other, lamports: 1 })], "durable_nonce"],
  ];
  for (const [ixs, code] of cases) {
    const p = await previewTransaction(legacy(...ixs), [me], fakeRpc({ pre: { [me]: { lamports: 10, owner: BH } } }));
    assert.ok(p.blocking.includes(code), `${code} expected in ${p.blocking}`);
    assert.ok(p.warnings.some((w) => w.code === code));
  }
  const mine = await previewTransaction(legacy(closeMine), [me], fakeRpc({ pre: { [me]: { lamports: 10, owner: BH } } }));
  assert.ok(mine.warnings.some((w) => w.code === "close_account")); assert.ok(!mine.blocking.includes("close_to_other"));
  const unk = await previewTransaction(legacy(unknown), [me], fakeRpc({ pre: { [me]: { lamports: 10, owner: BH } } }));
  assert.ok(unk.warnings.some((w) => w.code === "unknown_program"));
  assert.equal(unk.instructions[0].dataHex, "0102");
});

test("simulation-derived owner change, delegate and token balance changes", async () => {
  const ta = Keypair.generate().publicKey;
  const ix = SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: ta, lamports: 1 });
  const raw = legacy(ix);
  const rpc = fakeRpc({
    pre: { [me]: { lamports: 100, owner: BH }, [ta.toBase58()]: { lamports: 5, owner: TOKEN, data: tokenAccount(USDC, user.publicKey, 5_000_000n) } },
    post: { [me]: { lamports: 99, owner: other.toBase58() }, [ta.toBase58()]: { lamports: 5, owner: TOKEN, data: tokenAccount(USDC, user.publicKey, 2_500_000n, other, 7n) } },
    mints: { [USDC.toBase58()]: { decimals: 6 } },
  });
  const p = await previewTransaction(raw, [me], rpc);
  assert.ok(p.blocking.includes("owner_change"));
  assert.ok(p.blocking.includes("delegate_set"));
  const usdc = p.balanceChanges.find((c) => c.mint === USDC.toBase58())!;
  assert.equal(usdc.symbol, "USDC"); assert.equal(usdc.uiDelta, "-2.5");
});

test("simulation error and RPC failure fall back to raw details", async () => {
  const raw = legacy(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: other, lamports: 1 }));
  const failed = await previewTransaction(raw, [me], fakeRpc({ err: { InstructionError: [0, "Custom"] } }));
  assert.equal(failed.simulation.ok, false); assert.ok(failed.blocking.includes("sim_failed"));
  const down = await previewTransaction(raw, [me], fakeRpc({ throwSim: true }));
  assert.ok(down.blocking.includes("could_not_simulate"));
  assert.equal(down.instructions.length, 1); assert.equal(down.programs[0].name, "System Program");
  const none = await previewTransaction(raw, [me], null);
  assert.ok(none.blocking.includes("could_not_simulate"));
});

test("large outflow warning", async () => {
  const raw = legacy(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: other, lamports: 5e9 }));
  const p = await previewTransaction(raw, [me], fakeRpc({ pre: { [me]: { lamports: 6e9, owner: BH } }, post: { [me]: { lamports: 1e9 - 5000, owner: BH } } }));
  assert.ok(p.warnings.some((w) => w.code === "large_outflow"));
});

test("formatUnits", () => {
  assert.equal(formatUnits(-1_500_000n, 6), "-1.5");
  assert.equal(formatUnits(42n, 0), "+42");
  assert.equal(formatUnits(1n, 9), "+0.000000001");
});

// ---- auto-approve rules ----
const okPreview = async (lamports = 1000) => previewTransaction(
  legacy(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: other, lamports })), [me],
  fakeRpc({ pre: { [me]: { lamports: 1e9, owner: BH } }, post: { [me]: { lamports: 1e9 - lamports - 5000, owner: BH } } }));

test("auto-approve: limits, expiry, programs and blockers", async () => {
  const s = createSession("https://dapp.example", { durationMs: 3600_000, maxTotalSol: 0.01, maxPerTxSol: 0.005, allowedPrograms: [BH] }, 1000);
  const p = await okPreview();
  assert.deepEqual(checkAutoApprove(s, [p], 2000), { ok: true, outflowLamports: 6000 });
  assert.equal(checkAutoApprove(s, [p], 1000 + 3600_001).ok, false);
  assert.equal(checkAutoApprove(undefined, [p]).ok, false);
  const big = await okPreview(6_000_000);
  assert.match((checkAutoApprove(s, [big], 2000) as { reason: string }).reason, /per-transaction/);
  assert.match((checkAutoApprove({ ...s, spentLamports: 9_999_000 }, [p], 2000) as { reason: string }).reason, /total/);
  const other = createSession("https://dapp.example", { durationMs: 3600_000, maxTotalSol: 1, maxPerTxSol: 1, allowedPrograms: [TOKEN] }, 1000);
  assert.match((checkAutoApprove(other, [p], 2000) as { reason: string }).reason, /program not allowed/);
  const failed = await previewTransaction(legacy(SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: other.origin ? user.publicKey : user.publicKey, lamports: 1 })), [me], fakeRpc({ err: "BlockhashNotFound" }));
  assert.equal(checkAutoApprove(s, [failed], 2000).ok, false);
  const assign = await previewTransaction(legacy(SystemProgram.assign({ accountPubkey: user.publicKey, programId: Keypair.generate().publicKey })), [me], fakeRpc({ pre: { [me]: { lamports: 1, owner: BH } } }));
  assert.match((checkAutoApprove(s, [assign], 2000) as { reason: string }).reason, /manual review/);
  assert.throws(() => createSession("o", { durationMs: 0, maxTotalSol: 1, maxPerTxSol: 1, allowedPrograms: [BH] }));
  assert.throws(() => createSession("o", { durationMs: 60_000, maxTotalSol: 1, maxPerTxSol: 2, allowedPrograms: [BH] }));
  assert.throws(() => createSession("o", { durationMs: 60_000, maxTotalSol: 1, maxPerTxSol: 1, allowedPrograms: [] }));
  assert.throws(() => createSession("o", { durationMs: 60_000, maxTotalSol: 1, maxPerTxSol: 1, allowedPrograms: ["not-a-key"] }));
});

// ---- SIWS ----
test("SIWS: domain must match the requesting origin; full field set", () => {
  assert.throws(() => checkSignIn({ domain: "evil.example" }, "https://dapp.example", [me]), (e: { message: string }) => /domain mismatch/.test(e.message));
  assert.throws(() => checkSignIn({ nonce: "a\nURI: x" }, "https://dapp.example", [me]), (e: { message: string }) => /single line/.test(e.message));
  assert.throws(() => checkSignIn({ address: other.toBase58() }, "https://dapp.example", [me]), (e: { message: string }) => /not in this wallet/.test(e.message));
  const c = checkSignIn({ uri: "https://other.example/x", chainId: "solana:devnet" }, "https://dapp.example", [me]);
  assert.equal(c.domain, "dapp.example"); assert.equal(c.address, me);
  assert.ok(c.warnings.some((w) => /URI host/.test(w)));
  const text = buildSignInMessage({ domain: "dapp.example", address: me, statement: "Hi", uri: "https://dapp.example", version: "1", chainId: "solana:devnet", nonce: "n0nce123", issuedAt: "2026-10-16T17:00:00Z", expirationTime: "2026-10-16T18:00:00Z", notBefore: "2026-10-16T17:00:00Z", requestId: "r1", resources: ["https://a", "https://b"] });
  assert.equal(text, `dapp.example wants you to sign in with your Solana account:\n${me}\n\nHi\n\nURI: https://dapp.example\nVersion: 1\nChain ID: solana:devnet\nNonce: n0nce123\nIssued At: 2026-10-16T17:00:00Z\nExpiration Time: 2026-10-16T18:00:00Z\nNot Before: 2026-10-16T17:00:00Z\nRequest ID: r1\nResources:\n- https://a\n- https://b`);
});
