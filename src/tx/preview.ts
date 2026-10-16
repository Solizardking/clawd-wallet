// Transaction preview: decode (legacy + v0 with lookup tables), simulate and
// summarize what a transaction does to the user's wallet. Original Clawd code.
import {
  PublicKey,
  VersionedMessage,
  VersionedTransaction,
  type AddressLookupTableAccount,
  type Connection,
} from "@solana/web3.js";
import { parseMintAccount } from "../clawd/names.js";
import {
  COMPUTE_BUDGET, KNOWN_MINTS, KNOWN_PROGRAMS, SYSTEM, U64_MAX,
  b58, decodeInstruction, parseTokenAccount, type IxKind,
} from "./programs.js";

export type WarningLevel = "danger" | "warn" | "info";
export type PreviewWarning = { level: WarningLevel; code: string; message: string };
export type BalanceChange = {
  owner: string; mint: string | null; symbol: string; name?: string | null;
  decimals: number; rawDelta: string; uiDelta: string;
};
export type IxView = {
  index: number; programId: string; programName: string | null; kind: IxKind; summary: string;
  accounts: { address: string; signer: boolean; writable: boolean }[]; dataHex: string;
};
export type TxPreview = {
  version: "legacy" | 0;
  feePayer: string;
  signers: string[];
  walletSigners: string[];
  baseFeeLamports: number;
  priorityFeeLamports: number;
  feeLamports: number;
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: string;
  programs: { id: string; name: string | null }[];
  writable: string[];
  instructions: IxView[];
  simulation: { ok: boolean; error?: string; logs?: string[]; unitsConsumed?: number; skipped?: boolean };
  balanceChanges: BalanceChange[];
  /** Net SOL leaving the user's wallet accounts, including fees (lamports, >= 0). */
  solOutflowLamports: number;
  warnings: PreviewWarning[];
  /** Warning codes that rule out auto-approval. */
  blocking: string[];
  durableNonce: boolean;
};

/** Narrow RPC surface (a web3.js Connection satisfies it; tests use a fake). */
export type PreviewRpc = Pick<Connection,
  "getAddressLookupTable" | "getMultipleAccountsInfo" | "getMultipleParsedAccounts" | "simulateTransaction" | "getFeeForMessage">;

const BLOCKING = new Set([
  "sim_failed", "could_not_simulate", "set_authority", "assign", "owner_change", "close_to_other",
  "token_approve", "unlimited_approve", "delegate_set", "durable_nonce", "lookup_unresolved",
  "nonce_authority", "loader_authority", "stake_authority", "not_a_transaction",
]);

const hex = (d: Uint8Array) => Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");

export function formatUnits(raw: bigint, decimals: number): string {
  const neg = raw < 0n; const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base; const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : "+"}${whole}${frac ? "." + frac : ""}`;
}

/** Decode raw bytes as a wire transaction, else as a bare message. */
export function decodeTransactionBytes(raw: Uint8Array): { tx: VersionedTransaction; isMessageOnly: boolean } {
  try {
    const tx = VersionedTransaction.deserialize(raw);
    return { tx, isMessageOnly: false };
  } catch {
    const message = VersionedMessage.deserialize(raw);
    return { tx: new VersionedTransaction(message), isMessageOnly: true };
  }
}

/** Bound every RPC call so a hung endpoint cannot stall the approval screen. */
function timed<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`RPC timed out after ${ms / 1000}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

function boundedRpc(rpc: PreviewRpc, ms: number): PreviewRpc {
  return {
    getAddressLookupTable: (...a: Parameters<PreviewRpc["getAddressLookupTable"]>) => timed(rpc.getAddressLookupTable(...a), ms),
    getMultipleAccountsInfo: (...a: Parameters<PreviewRpc["getMultipleAccountsInfo"]>) => timed(rpc.getMultipleAccountsInfo(...a), ms),
    getMultipleParsedAccounts: (...a: Parameters<PreviewRpc["getMultipleParsedAccounts"]>) => timed(rpc.getMultipleParsedAccounts(...a), ms),
    simulateTransaction: ((...a: unknown[]) => timed((rpc.simulateTransaction as (...x: unknown[]) => Promise<unknown>)(...a), ms)) as PreviewRpc["simulateTransaction"],
    getFeeForMessage: (...a: Parameters<PreviewRpc["getFeeForMessage"]>) => timed(rpc.getFeeForMessage(...a), ms),
  };
}

export async function previewTransaction(
  raw: Uint8Array,
  walletAccounts: string[],
  rpcIn: PreviewRpc | null,
  opts: { largeOutflowLamports?: number; rpcTimeoutMs?: number } = {},
): Promise<TxPreview> {
  const rpc = rpcIn ? boundedRpc(rpcIn, opts.rpcTimeoutMs ?? 8000) : null;
  const warnings: PreviewWarning[] = [];
  const warn = (level: WarningLevel, code: string, message: string) => {
    if (!warnings.some((w) => w.code === code && w.message === message)) warnings.push({ level, code, message });
  };
  const { tx } = decodeTransactionBytes(raw);
  const msg = tx.message;
  const version = msg.version === "legacy" ? "legacy" : 0;

  // ---- resolve address lookup tables ----
  const lookups = msg.addressTableLookups ?? [];
  const tables: AddressLookupTableAccount[] = [];
  let lookupsResolved = true;
  for (const l of lookups) {
    try {
      const t = rpc ? (await rpc.getAddressLookupTable(l.accountKey)).value : null;
      if (t) tables.push(t); else lookupsResolved = false;
    } catch { lookupsResolved = false; }
  }
  let keys: string[];
  if (lookupsResolved) {
    const k = msg.getAccountKeys({ addressLookupTableAccounts: tables });
    keys = [...k.staticAccountKeys, ...(k.accountKeysFromLookups?.writable ?? []), ...(k.accountKeysFromLookups?.readonly ?? [])].map((p) => p.toBase58());
  } else {
    keys = msg.staticAccountKeys.map((p) => p.toBase58());
    lookups.forEach((l, i) => {
      for (const idx of l.writableIndexes) keys.push(`lookup${i}:w${idx}`);
      for (const idx of l.readonlyIndexes) keys.push(`lookup${i}:r${idx}`);
    });
    warn("danger", "lookup_unresolved", "Could not resolve address lookup tables; some accounts are unknown.");
  }

  const h = msg.header;
  const nStatic = msg.staticAccountKeys.length;
  const nLookupW = lookups.reduce((s, l) => s + l.writableIndexes.length, 0);
  const isSigner = (i: number) => i < h.numRequiredSignatures;
  const isWritable = (i: number) => {
    if (i >= nStatic) return i - nStatic < nLookupW;
    if (i < h.numRequiredSignatures) return i < h.numRequiredSignatures - h.numReadonlySignedAccounts;
    return i < nStatic - h.numReadonlyUnsignedAccounts;
  };
  const signers = keys.slice(0, h.numRequiredSignatures);
  const wallet = new Set(walletAccounts);
  const walletSigners = signers.filter((s) => wallet.has(s));
  const writable = keys.filter((_, i) => isWritable(i));

  // ---- instructions ----
  let cuLimit: number | null = null; let cuPrice = 0n; let nonCb = 0;
  const programs = new Map<string, string | null>();
  const instructions: IxView[] = msg.compiledInstructions.map((ix, index) => {
    const programId = keys[ix.programIdIndex];
    const ixKeys = ix.accountKeyIndexes.map((i) => keys[i]);
    const data = Uint8Array.from(ix.data);
    const d = decodeInstruction(programId, ixKeys, data);
    const name = KNOWN_PROGRAMS[programId] ?? null;
    programs.set(programId, name);
    if (programId !== COMPUTE_BUDGET) nonCb++;
    if (d.kind === "cu_limit") cuLimit = Number(d.value);
    if (d.kind === "cu_price") cuPrice = d.value ?? 0n;
    if (!name) warn("warn", "unknown_program", `Unknown program ${programId}`);
    const mine = (a?: string) => !!a && wallet.has(a);
    switch (d.kind) {
      case "assign": if (mine(d.owner)) warn("danger", "assign", `Instruction ${index + 1} reassigns your account ${d.owner} to another program (you would lose control).`); break;
      case "set_authority": warn("danger", "set_authority", `Instruction ${index + 1} changes a token/mint authority (SetAuthority).`); break;
      case "loader_set_authority": warn("danger", "loader_authority", `Instruction ${index + 1} changes a program's upgrade authority.`); break;
      case "stake_authorize": warn("danger", "stake_authority", `Instruction ${index + 1} changes a stake account authority.`); break;
      case "nonce_authority": warn("danger", "nonce_authority", `Instruction ${index + 1} changes a nonce account authority.`); break;
      case "close_account": case "loader_close":
        if (d.to && !mine(d.to)) warn("danger", "close_to_other", `Instruction ${index + 1} closes an account and sends its balance to ${d.to}, which is not your wallet.`);
        else warn("info", "close_account", `Instruction ${index + 1} closes an account (rent returns to you).`);
        break;
      case "token_approve":
        if (d.amount === U64_MAX) warn("danger", "unlimited_approve", `Instruction ${index + 1} grants ${d.to} UNLIMITED spending of a token account.`);
        else warn("danger", "token_approve", `Instruction ${index + 1} lets ${d.to} spend tokens on your behalf (delegation).`);
        break;
    }
    return {
      index, programId, programName: name, kind: d.kind, summary: d.summary,
      accounts: ix.accountKeyIndexes.map((i) => ({ address: keys[i], signer: isSigner(i), writable: isWritable(i) })),
      dataHex: hex(data),
    };
  });
  const first = instructions[0];
  const durableNonce = !!first && first.programId === SYSTEM && first.kind === "advance_nonce";
  if (durableNonce) warn("warn", "durable_nonce", "Uses a durable nonce: this signed transaction stays valid indefinitely and could be submitted later.");

  // ---- fees ----
  const computeUnitLimit = cuLimit ?? Math.min(1_400_000, 200_000 * Math.max(1, nonCb));
  const priorityFeeLamports = Number((cuPrice * BigInt(computeUnitLimit) + 999_999n) / 1_000_000n);
  let baseFeeLamports = 5000 * h.numRequiredSignatures;
  try {
    const f = rpc ? (await rpc.getFeeForMessage(msg, "confirmed")).value : null;
    if (typeof f === "number") baseFeeLamports = Math.max(0, f - priorityFeeLamports);
  } catch { /* keep estimate */ }
  const feeLamports = baseFeeLamports + priorityFeeLamports;

  // ---- simulation ----
  const watch = [...new Set([...walletSigners, ...walletAccounts.filter((a) => keys.includes(a)), ...writable.filter((k) => !k.startsWith("lookup"))])].slice(0, 40);
  const simulation: TxPreview["simulation"] = { ok: false };
  const balanceChanges: BalanceChange[] = [];
  let solOutflowLamports = feeLamports;
  if (!rpc) {
    simulation.skipped = true; simulation.error = "No RPC available";
    warn("danger", "could_not_simulate", "Could not simulate this transaction. Review the raw details carefully.");
  } else {
    try {
      const pks = watch.map((a) => new PublicKey(a));
      const pre = await rpc.getMultipleAccountsInfo(pks);
      const sim = await rpc.simulateTransaction(tx, {
        sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
        accounts: { encoding: "base64", addresses: watch },
      });
      const v = sim.value;
      simulation.logs = (v.logs ?? []).slice(-40);
      simulation.unitsConsumed = v.unitsConsumed ?? undefined;
      if (v.err) {
        simulation.error = typeof v.err === "string" ? v.err : JSON.stringify(v.err);
        warn("danger", "sim_failed", `Simulation failed: ${simulation.error}. This transaction will likely fail or behave unexpectedly.`);
      } else {
        simulation.ok = true;
        const post = v.accounts ?? [];
        let solDelta = 0n;
        const tokenDeltas = new Map<string, { owner: string; mint: string; delta: bigint }>();
        watch.forEach((addr, i) => {
          const a = pre[i];
          const p = post[i];
          const preL = BigInt(a?.lamports ?? 0);
          const postL = p ? BigInt(p.lamports) : preL;
          const postData = p ? Uint8Array.from(atob((p.data as unknown as string[])[0] ?? ""), (c) => c.charCodeAt(0)) : null;
          if (wallet.has(addr)) {
            solDelta += postL - preL;
            const preOwner = a?.owner?.toBase58() ?? SYSTEM;
            if (p && p.owner !== preOwner) warn("danger", "owner_change", `Your account ${addr} would be reassigned to program ${p.owner}.`);
          }
          const preTok = a ? parseTokenAccount(a.owner.toBase58(), Uint8Array.from(a.data)) : null;
          const postTok = p && postData ? parseTokenAccount(p.owner, postData) : null;
          const tokOwner = preTok?.owner ?? postTok?.owner;
          if (preTok && wallet.has(preTok.owner) && postTok && postTok.owner !== preTok.owner) {
            warn("danger", "owner_change", `Ownership of your token account ${addr} would move to ${postTok.owner}.`);
          }
          if (postTok?.delegate && postTok.delegate !== preTok?.delegate && tokOwner && wallet.has(tokOwner)) {
            warn("danger", postTok.delegatedAmount === U64_MAX ? "unlimited_approve" : "delegate_set", `A delegate (${postTok.delegate}) would be able to spend from your token account ${addr}.`);
          }
          if (tokOwner && wallet.has(tokOwner)) {
            const mint = (preTok ?? postTok)!.mint;
            const delta = (p ? postTok?.amount ?? 0n : preTok?.amount ?? 0n) - (preTok?.amount ?? 0n);
            if (delta !== 0n) {
              const k = `${tokOwner}:${mint}`;
              const cur = tokenDeltas.get(k) ?? { owner: tokOwner, mint, delta: 0n };
              cur.delta += delta; tokenDeltas.set(k, cur);
            }
          }
        });
        // Simulated post-state may or may not include the fee; never under-count.
        const out = solDelta < 0n ? Number(-solDelta) : 0;
        solOutflowLamports = Math.max(out, feeLamports);
        if (solDelta !== 0n) {
          balanceChanges.push({ owner: walletSigners[0] ?? walletAccounts[0] ?? "", mint: null, symbol: "SOL", decimals: 9, rawDelta: solDelta.toString(), uiDelta: formatUnits(solDelta, 9) });
        }
        if (tokenDeltas.size) {
          const mints = [...new Set([...tokenDeltas.values()].map((t) => t.mint))];
          let parsed: Awaited<ReturnType<PreviewRpc["getMultipleParsedAccounts"]>>["value"] = [];
          try { parsed = (await rpc.getMultipleParsedAccounts(mints.map((m) => new PublicKey(m)))).value; } catch { /* names optional */ }
          const meta = new Map<string, { symbol: string; name: string | null; decimals: number }>();
          mints.forEach((m, i) => {
            const info = (parsed[i]?.data as { parsed?: { info?: { decimals?: number; extensions?: { extension?: string; state?: { symbol?: string } }[] } } } | undefined)?.parsed?.info;
            const known = KNOWN_MINTS[m];
            const metaSym = info?.extensions?.find((e) => e.extension === "tokenMetadata")?.state?.symbol;
            const name = parseMintAccount(parsed[i] ?? null);
            meta.set(m, { symbol: known?.symbol ?? metaSym ?? name ?? `${m.slice(0, 4)}…${m.slice(-4)}`, name, decimals: info?.decimals ?? known?.decimals ?? 0 });
          });
          for (const t of tokenDeltas.values()) {
            const m = meta.get(t.mint)!;
            balanceChanges.push({ owner: t.owner, mint: t.mint, symbol: m.symbol, name: m.name, decimals: m.decimals, rawDelta: t.delta.toString(), uiDelta: formatUnits(t.delta, m.decimals) });
          }
        }
      }
    } catch (e) {
      simulation.error = (e as Error).message ?? String(e);
      warn("danger", "could_not_simulate", `Could not simulate this transaction (${simulation.error}). Review the raw details carefully.`);
    }
  }
  const large = opts.largeOutflowLamports ?? 1_000_000_000;
  if (solOutflowLamports >= large) warn("warn", "large_outflow", `Large outflow: about ${solOutflowLamports / 1e9} SOL leaves your wallet.`);
  if (walletSigners.length === 0) warn("warn", "no_wallet_signer", "None of your accounts is a required signer of this transaction.");

  return {
    version, feePayer: keys[0], signers, walletSigners, baseFeeLamports, priorityFeeLamports, feeLamports,
    computeUnitLimit, computeUnitPriceMicroLamports: cuPrice.toString(),
    programs: [...programs].map(([id, name]) => ({ id, name })), writable, instructions, simulation,
    balanceChanges, solOutflowLamports, warnings,
    blocking: [...new Set(warnings.filter((w) => BLOCKING.has(w.code)).map((w) => w.code))],
    durableNonce,
  };
}

/** Preview for bytes that could not even be decoded. */
export function undecodablePreview(error: string): TxPreview {
  return {
    version: "legacy", feePayer: "", signers: [], walletSigners: [], baseFeeLamports: 0, priorityFeeLamports: 0, feeLamports: 0,
    computeUnitLimit: 0, computeUnitPriceMicroLamports: "0", programs: [], writable: [], instructions: [],
    simulation: { ok: false, error, skipped: true }, balanceChanges: [], solOutflowLamports: 0,
    warnings: [{ level: "danger", code: "not_a_transaction", message: `Could not decode transaction: ${error}` }],
    blocking: ["not_a_transaction"], durableNonce: false,
  };
}

export { b58 };
