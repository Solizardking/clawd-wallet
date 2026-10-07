import { Buffer } from "buffer";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import {
  AVAILABLE_NETWORKS,
  CUSTOM_NETWORK_CLUSTER,
  customNetwork,
  type Network,
  type PendingActionType,
  type PendingActionView,
  type PopupRequest,
  type PopupState,
  type ProviderEvent,
  type ProviderRequest,
  type RequestAccountsResp,
  type SignTransactionResp,
  type WalletState,
} from "./protocol.js";
import {
  deriveAccounts,
  generateMnemonic,
  mnemonicToSeedHex,
  validateMnemonic,
  type DerivedAccount,
} from "./wallet/keyring.js";
import { encryptVault, decryptVault } from "./wallet/vault.js";
import {
  clearSession,
  loadConfig,
  loadSession,
  loadVault,
  saveConfig,
  saveSession,
  saveVault,
  type PersistedConfig,
} from "./wallet/store.js";

// globalThis.Buffer is required by @solana/web3.js and bip39 in a bundled SW.
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ||= Buffer;

const DEFAULT_HELMSMAN_API = "http://localhost:8787";

async function packedApiUrl(): Promise<string | null> {
  try {
    const cfg = (await (await fetch(chrome.runtime.getURL("config.json"))).json()) as {
      apiUrl?: string;
    };
    return cfg.apiUrl?.replace(/\/$/, "") || null;
  } catch {
    return null;
  }
}

async function packedRpcUrl(): Promise<string | null> {
  try {
    const cfg = (await (await fetch(chrome.runtime.getURL("config.json"))).json()) as {
      rpcUrl?: string;
    };
    return typeof cfg.rpcUrl === "string" && cfg.rpcUrl.startsWith("http") ? cfg.rpcUrl : null;
  } catch {
    return null;
  }
}


async function helmsmanApi(): Promise<string> {
  const cfg = await loadConfig();
  if (cfg.helmsmanApiUrl?.trim()) return cfg.helmsmanApiUrl.trim().replace(/\/$/, "");
  return (await packedApiUrl()) ?? DEFAULT_HELMSMAN_API;
}

// ---- In-memory (service-worker lifetime) unlocked state ----
type Unlocked = { mnemonic: string; seedHex: string; accounts: DerivedAccount[] };
let unlocked: Unlocked | null = null;

type PendingAction = PendingActionView & {
  resolve: (result: unknown) => void;
  reject: (error: { code?: number; message: string }) => void;
};
const pendingActions = new Map<string, PendingAction>();

let notificationWindowId: number | null = null;

function newId(): string {
  return crypto.randomUUID();
}

// ---- State helpers ----

// Restore the in-memory unlocked state from session storage after an MV3
// service-worker restart, rebuilding derived accounts from the persisted seed.
async function ensureUnlocked(): Promise<void> {
  if (unlocked) return;
  const session = await loadSession();
  if (!session) return;
  const accounts = await rebuildAccounts(session.seedHex);
  unlocked = { mnemonic: session.mnemonic, seedHex: session.seedHex, accounts };
}

async function walletState(): Promise<WalletState> {
  const vault = await loadVault();
  if (!vault) return "uninitialized";
  await ensureUnlocked();
  return unlocked ? "unlocked" : "locked";
}

function networksForConfig(cfg: PersistedConfig): Network[] {
  const nets = [...AVAILABLE_NETWORKS];
  if (cfg.customRpcUrl) {
    nets.unshift(customNetwork(cfg.customRpcUrl));
  }
  return nets;
}

function resolveSelectedNetwork(cfg: PersistedConfig): Network {
  if (cfg.selectedNetwork.cluster === CUSTOM_NETWORK_CLUSTER && cfg.customRpcUrl) {
    return customNetwork(cfg.customRpcUrl);
  }
  const hit = AVAILABLE_NETWORKS.find((n) => n.cluster === cfg.selectedNetwork.cluster);
  return hit ?? cfg.selectedNetwork;
}

async function connection(): Promise<Connection> {
  const cfg = await loadConfig();
  return new Connection(resolveSelectedNetwork(cfg).endpoint, "confirmed");
}

function accountAddresses(): string[] {
  return unlocked ? unlocked.accounts.map((a) => a.address) : [];
}

function findKeypair(address: string): DerivedAccount | undefined {
  return unlocked?.accounts.find((a) => a.address === address);
}

async function rebuildAccounts(seedHex: string): Promise<DerivedAccount[]> {
  const cfg = await loadConfig();
  return deriveAccounts(seedHex, Math.max(1, cfg.accountCount));
}

// ---- Event broadcasting to dapps ----

async function broadcast(event: ProviderEvent, data: unknown): Promise<void> {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    chrome.tabs.sendMessage(tab.id, { type: "solana:event", event, data }).catch(() => {});
  }
}

async function notifyStateChanged(): Promise<void> {
  await broadcast("stateChanged", { state: await walletState() });
}

// ---- Popup / notification window ----

async function openPopupWindow(): Promise<void> {
  if (notificationWindowId !== null) {
    try {
      const win = await chrome.windows.get(notificationWindowId);
      if (win && win.id !== undefined) {
        await chrome.windows.update(win.id, { focused: true });
        return;
      }
    } catch {
      notificationWindowId = null;
    }
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html?view=notification"),
    type: "popup",
    width: 360,
    height: 600,
  });
  notificationWindowId = win?.id ?? null;
}

function pendingViews(): PendingActionView[] {
  return [...pendingActions.values()].map(({ id, type, origin, tabId, message, signers }) => ({
    id,
    type,
    origin,
    tabId,
    message,
    signers,
  }));
}

function enqueueAction(
  type: PendingActionType,
  origin: string,
  extra: {
    tabId?: number;
    message?: string;
    signers?: string[];
    transaction?: string;
    to?: string;
    amountSol?: number;
  },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = newId();
    pendingActions.set(id, { id, type, origin, ...extra, resolve, reject });
    // Computer-use / agent mode: auto-approve without a popup. request_accounts
    // is always eligible (it authorizes the origin); other actions require the
    // origin to already be authorized so a site must connect first.
    void (async () => {
      const cfg = await loadConfig();
      const eligible =
        cfg.agentMode &&
        (type === "request_accounts" || cfg.authorizedOrigins.includes(origin));
      if (eligible) {
        try {
          await approveAction(id);
        } catch (err) {
          const e = err as { code?: number; message?: string };
          const a = pendingActions.get(id);
          a?.reject({ code: e.code, message: e.message ?? String(err) });
          pendingActions.delete(id);
        }
        return;
      }
      void openPopupWindow();
    })();
  });
}

// ---- Signing ----

function signMessageBytes(address: string, messageBytes: Uint8Array): Uint8Array {
  const acct = findKeypair(address);
  if (!acct) throw new Error(`Unknown signer: ${address}`);
  return nacl.sign.detached(messageBytes, acct.keypair.secretKey);
}

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build, sign (with the selected/source account), send, and return a SOL transfer signature. */
async function executeSendSol(from: string, to: string, sol: number): Promise<string> {
  if (!unlocked) throw { code: 4100, message: "Wallet is locked" };
  if (!to) throw { code: -32602, message: "Recipient required" };
  if (!sol || sol <= 0) throw { code: -32602, message: "Amount must be positive" };
  const acct = findKeypair(from);
  if (!acct) throw { code: -32602, message: "Unknown source account" };
  const conn = await connection();
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: acct.keypair.publicKey,
      toPubkey: new PublicKey(to),
      lamports: Math.round(sol * 1e9),
    }),
  );
  const { blockhash } = await conn.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = acct.keypair.publicKey;
  tx.sign(acct.keypair);
  return conn.sendRawTransaction(tx.serialize());
}


/** Accounts this wallet can sign for a legacy Transaction. */
function legacyMatchingKeypairs(tx: Transaction): import("@solana/web3.js").Keypair[] {
  if (!unlocked) return [];
  const wanted = new Set<string>();
  if (tx.feePayer) wanted.add(tx.feePayer.toBase58());
  for (const s of tx.signatures) {
    if (s.publicKey) wanted.add(s.publicKey.toBase58());
  }
  return unlocked.accounts.filter((a) => wanted.has(a.address)).map((a) => a.keypair);
}

/** Accounts this wallet can sign for a VersionedTransaction. */
function versionedMatchingKeypairs(vtx: VersionedTransaction): import("@solana/web3.js").Keypair[] {
  if (!unlocked) return [];
  const required = vtx.message.staticAccountKeys.slice(0, vtx.message.header.numRequiredSignatures);
  return unlocked.accounts
    .filter((a) => required.some((pk) => pk.equals(a.keypair.publicKey)))
    .map((a) => a.keypair);
}

/** Sign a base64 transaction (legacy or versioned) and return signed base64, without broadcasting. */
function executeSignOnly(txBase64: string): string {
  if (!unlocked) throw { code: 4100, message: "Wallet is locked" };
  const raw = bytesFromBase64(txBase64);
  // Prefer versioned when the first byte looks like a versioned tx (0x80 bit).
  const looksVersioned = raw.length > 0 && (raw[0] & 0x80) !== 0;
  if (looksVersioned) {
    const vtx = VersionedTransaction.deserialize(raw);
    const keypairs = versionedMatchingKeypairs(vtx);
    if (keypairs.length === 0) throw { code: 4100, message: "No matching signer in this wallet" };
    vtx.sign(keypairs);
    return Buffer.from(vtx.serialize()).toString("base64");
  }
  try {
    const tx = Transaction.from(raw);
    const keypairs = legacyMatchingKeypairs(tx);
    if (keypairs.length === 0) throw { code: 4100, message: "No matching signer in this wallet" };
    tx.partialSign(...keypairs);
    return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");
  } catch (legacyErr) {
    try {
      const vtx = VersionedTransaction.deserialize(raw);
      const keypairs = versionedMatchingKeypairs(vtx);
      if (keypairs.length === 0) throw { code: 4100, message: "No matching signer in this wallet" };
      vtx.sign(keypairs);
      return Buffer.from(vtx.serialize()).toString("base64");
    } catch {
      const e = legacyErr as { message?: string };
      throw { code: -32602, message: `Could not sign transaction: ${e.message ?? "invalid transaction"}` };
    }
  }
}

/**
 * Sign a client-built transaction (base64, legacy or versioned) with whichever
 * of our accounts are required signers, then send it and return the signature.
 * This is the primary computer-use path: an agent builds a tx with web3.js and
 * hands it to the wallet to sign+broadcast.
 */
async function executeSignAndSend(txBase64: string): Promise<string> {
  if (!unlocked) throw { code: 4100, message: "Wallet is locked" };
  const raw = bytesFromBase64(txBase64);
  const conn = await connection();
  const looksVersioned = raw.length > 0 && (raw[0] & 0x80) !== 0;
  if (looksVersioned) {
    const vtx = VersionedTransaction.deserialize(raw);
    const keypairs = versionedMatchingKeypairs(vtx);
    if (keypairs.length === 0) throw { code: 4100, message: "No matching signer in this wallet" };
    vtx.sign(keypairs);
    return await conn.sendRawTransaction(vtx.serialize());
  }
  try {
    const tx = Transaction.from(raw);
    const keypairs = legacyMatchingKeypairs(tx);
    if (keypairs.length === 0) throw { code: 4100, message: "No matching signer in this wallet" };
    tx.partialSign(...keypairs);
    return await conn.sendRawTransaction(tx.serialize());
  } catch (legacyErr) {
    try {
      const vtx = VersionedTransaction.deserialize(raw);
      const keypairs = versionedMatchingKeypairs(vtx);
      if (keypairs.length === 0) throw { code: 4100, message: "No matching signer in this wallet" };
      vtx.sign(keypairs);
      return await conn.sendRawTransaction(vtx.serialize());
    } catch {
      const e = legacyErr as { message?: string };
      throw { code: -32602, message: `Could not sign/send transaction: ${e.message ?? "invalid transaction"}` };
    }
  }
}

// ---- Provider RPC (from dapps via content script) ----

async function handleProviderRequest(req: ProviderRequest, origin: string, tabId?: number) {
  await ensureUnlocked();
  const cfg = await loadConfig();
  switch (req.method) {
    case "wallet_getState":
      return { state: await walletState() };

    case "wallet_getCluster":
      return cfg.selectedNetwork;

    case "wallet_requestAccounts": {
      const params = (req.params ?? {}) as { promptAuthorization?: boolean };
      const state = await walletState();
      if (cfg.authorizedOrigins.includes(origin) && state === "unlocked") {
        return { accounts: accountAddresses() } as RequestAccountsResp;
      }
      if (params.promptAuthorization === false) {
        throw { code: 4100, message: "Unauthorized. Request permissions first." };
      }
      return (await enqueueAction("request_accounts", origin, { tabId })) as RequestAccountsResp;
    }

    case "wallet_signMessage": {
      if (!unlocked) throw { code: 4100, message: "Wallet is locked" };
      if (!cfg.authorizedOrigins.includes(origin)) {
        throw { code: 4100, message: "Unauthorized origin" };
      }
      const params = (req.params ?? {}) as { message?: string; display?: string };
      if (!params.message) throw { code: -32602, message: "message required" };
      return (await enqueueAction("sign_message", origin, {
        tabId,
        message: params.message,
        signers: cfg.selectedAccount ? [cfg.selectedAccount] : accountAddresses().slice(0, 1),
      })) as { publicKey: string; signature: string };
    }

    case "wallet_signTransaction":
    case "wallet_signAllTransactions": {
      if (!unlocked) throw { code: 4100, message: "Wallet is locked" };
      if (!cfg.authorizedOrigins.includes(origin)) {
        throw { code: 4100, message: "Unauthorized origin" };
      }
      const params = (req.params ?? {}) as { message?: string; signer?: string[] };
      if (!params.message) throw { code: -32602, message: "message (base58) required" };
      return (await enqueueAction("sign_transaction", origin, {
        tabId,
        message: params.message,
        signers: params.signer ?? (cfg.selectedAccount ? [cfg.selectedAccount] : accountAddresses()),
      })) as SignTransactionResp;
    }

    case "wallet_signAndSendTransaction": {
      if (!unlocked) throw { code: 4100, message: "Wallet is locked" };
      if (!cfg.authorizedOrigins.includes(origin)) {
        throw { code: 4100, message: "Unauthorized origin" };
      }
      const params = (req.params ?? {}) as { transaction?: string };
      if (!params.transaction) throw { code: -32602, message: "transaction (base64) required" };
      return (await enqueueAction("sign_and_send", origin, {
        tabId,
        transaction: params.transaction,
      })) as { signature: string };
    }

    case "wallet_signTransactionB64": {
      if (!unlocked) throw { code: 4100, message: "Wallet is locked" };
      if (!cfg.authorizedOrigins.includes(origin)) {
        throw { code: 4100, message: "Unauthorized origin" };
      }
      const params = (req.params ?? {}) as { transaction?: string };
      if (!params.transaction) throw { code: -32602, message: "transaction (base64) required" };
      return (await enqueueAction("sign_b64", origin, {
        tabId,
        transaction: params.transaction,
      })) as { signedTransaction: string };
    }

    case "wallet_sendSol": {
      if (!unlocked) throw { code: 4100, message: "Wallet is locked" };
      if (!cfg.authorizedOrigins.includes(origin)) {
        throw { code: 4100, message: "Unauthorized origin" };
      }
      const params = (req.params ?? {}) as { to?: string; sol?: number };
      if (!params.to || !params.sol) throw { code: -32602, message: "to and sol required" };
      return (await enqueueAction("send_sol", origin, {
        tabId,
        to: params.to,
        amountSol: params.sol,
      })) as { signature: string };
    }

    case "wallet_getBalance": {
      const params = (req.params ?? {}) as { address?: string };
      const target = params.address ?? cfg.selectedAccount;
      if (!target) throw { code: -32602, message: "No account" };
      const conn = await connection();
      const lamports = await conn.getBalance(new PublicKey(target));
      return { address: target, lamports, sol: lamports / 1e9 };
    }

    default:
      throw { code: -32601, message: `Unsupported method: ${(req as ProviderRequest).method}` };
  }
}

// ---- Approvals resolved from popup ----

async function approveAction(id: string): Promise<void> {
  const action = pendingActions.get(id);
  if (!action) return;
  const cfg = await loadConfig();

  if (action.type === "request_accounts") {
    if (!cfg.authorizedOrigins.includes(action.origin)) {
      cfg.authorizedOrigins.push(action.origin);
      await saveConfig(cfg);
    }
    action.resolve({ accounts: accountAddresses() } as RequestAccountsResp);
    pendingActions.delete(id);
    await broadcast("accountsChanged", accountAddresses());
    return;
  }

  if (action.type === "sign_message") {
    const signer = action.signers?.[0] ?? cfg.selectedAccount;
    if (!signer) throw new Error("No signer");
    // message is treated as UTF-8 text for signing display; sign raw bytes.
    const bytes = new TextEncoder().encode(action.message ?? "");
    const signature = signMessageBytes(signer, bytes);
    action.resolve({ publicKey: signer, signature: bs58.encode(signature) });
    pendingActions.delete(id);
    return;
  }

  if (action.type === "sign_transaction") {
    const message = action.message ?? "";
    const signers = action.signers ?? [];
    const messageBytes = bs58.decode(message);
    const signatureResults = signers.map((address) => ({
      publicKey: address,
      signature: bs58.encode(signMessageBytes(address, messageBytes)),
    }));
    action.resolve({ signatureResults } as SignTransactionResp);
    pendingActions.delete(id);
    return;
  }

  if (action.type === "sign_and_send") {
    try {
      const signature = await executeSignAndSend(action.transaction ?? "");
      action.resolve({ signature });
    } catch (err) {
      const e = err as { code?: number; message?: string };
      action.reject({ code: e.code, message: e.message ?? String(err) });
    }
    pendingActions.delete(id);
    return;
  }

  if (action.type === "sign_b64") {
    try {
      const signedTransaction = executeSignOnly(action.transaction ?? "");
      action.resolve({ signedTransaction });
    } catch (err) {
      const e = err as { code?: number; message?: string };
      action.reject({ code: e.code, message: e.message ?? String(err) });
    }
    pendingActions.delete(id);
    return;
  }

  if (action.type === "send_sol") {
    try {
      const from = cfg.selectedAccount ?? accountAddresses()[0];
      const signature = await executeSendSol(from, action.to ?? "", action.amountSol ?? 0);
      action.resolve({ signature });
    } catch (err) {
      const e = err as { code?: number; message?: string };
      action.reject({ code: e.code, message: e.message ?? String(err) });
    }
    pendingActions.delete(id);
    return;
  }
}

function declineAction(id: string): void {
  const action = pendingActions.get(id);
  if (!action) return;
  action.reject({ code: 4001, message: "User rejected the request" });
  pendingActions.delete(id);
}

// ---- Popup RPC ----

async function popupGetState(): Promise<PopupState> {
  let cfg = await loadConfig();
  // Seed custom RPC from packed config.json once (local Helius etc.).
  if (!cfg.customRpcUrl) {
    const packed = await packedRpcUrl();
    if (packed) {
      cfg = {
        ...cfg,
        customRpcUrl: packed,
        selectedNetwork: customNetwork(packed),
      };
      await saveConfig(cfg);
    }
  }
  return {
    walletState: await walletState(),
    accounts: accountAddresses(),
    selectedAccount: cfg.selectedAccount,
    selectedNetwork: resolveSelectedNetwork(cfg),
    availableNetworks: networksForConfig(cfg),
    authorizedOrigins: cfg.authorizedOrigins,
    pendingActions: pendingViews(),
    agentMode: cfg.agentMode,
    helmsmanApiUrl: await helmsmanApi(),
    customRpcUrl: cfg.customRpcUrl ?? "",
  };
}

async function handlePopupRequest(req: PopupRequest): Promise<unknown> {
  await ensureUnlocked();
  const cfg = await loadConfig();
  switch (req.method) {
    case "popup_getState":
      return popupGetState();

    case "popup_createWallet": {
      const { password } = (req.params ?? {}) as { password?: string };
      if (!password || password.length < 8)
        throw new Error("Password must be at least 8 characters");
      const mnemonic = generateMnemonic();
      const seedHex = mnemonicToSeedHex(mnemonic);
      await saveVault(await encryptVault(JSON.stringify({ mnemonic, seedHex }), password));
      const accounts = deriveAccounts(seedHex, 1);
      unlocked = { mnemonic, seedHex, accounts };
      await saveSession({ mnemonic, seedHex });
      const next: PersistedConfig = {
        ...cfg,
        accountCount: 1,
        selectedAccount: accounts[0].address,
      };
      await saveConfig(next);
      await notifyStateChanged();
      return { mnemonic, accounts: accountAddresses() };
    }

    case "popup_restoreWallet": {
      const { mnemonic, password } = (req.params ?? {}) as {
        mnemonic?: string;
        password?: string;
      };
      if (!mnemonic || !validateMnemonic(mnemonic)) throw new Error("Invalid recovery phrase");
      if (!password || password.length < 8)
        throw new Error("Password must be at least 8 characters");
      const seedHex = mnemonicToSeedHex(mnemonic);
      await saveVault(await encryptVault(JSON.stringify({ mnemonic, seedHex }), password));
      const accounts = deriveAccounts(seedHex, 1);
      unlocked = { mnemonic: mnemonic.trim(), seedHex, accounts };
      await saveSession({ mnemonic: mnemonic.trim(), seedHex });
      await saveConfig({ ...cfg, accountCount: 1, selectedAccount: accounts[0].address });
      await notifyStateChanged();
      return { accounts: accountAddresses() };
    }

    case "popup_unlockWallet": {
      const { password } = (req.params ?? {}) as { password?: string };
      const vault = await loadVault();
      if (!vault) throw new Error("No wallet found");
      const plaintext = await decryptVault(vault, password ?? "");
      const { mnemonic, seedHex } = JSON.parse(plaintext) as {
        mnemonic: string;
        seedHex: string;
      };
      const accounts = await rebuildAccounts(seedHex);
      unlocked = { mnemonic, seedHex, accounts };
      await saveSession({ mnemonic, seedHex });
      if (!cfg.selectedAccount && accounts[0]) {
        await saveConfig({ ...cfg, selectedAccount: accounts[0].address });
      }
      await notifyStateChanged();
      return { accounts: accountAddresses() };
    }

    case "popup_lockWallet":
      unlocked = null;
      await clearSession();
      await notifyStateChanged();
      return { ok: true };

    case "popup_addAccount": {
      if (!unlocked) throw new Error("Wallet is locked");
      const nextCount = unlocked.accounts.length + 1;
      unlocked.accounts = deriveAccounts(unlocked.seedHex, nextCount);
      await saveConfig({ ...cfg, accountCount: nextCount });
      await broadcast("accountsChanged", accountAddresses());
      return { accounts: accountAddresses() };
    }

    case "popup_selectAccount": {
      const { address } = (req.params ?? {}) as { address?: string };
      if (!address || !accountAddresses().includes(address))
        throw new Error("Unknown account");
      await saveConfig({ ...cfg, selectedAccount: address });
      await broadcast("accountsChanged", accountAddresses());
      return { selectedAccount: address };
    }

    case "popup_changeNetwork": {
      const { cluster } = (req.params ?? {}) as { cluster?: string };
      let network: Network | undefined;
      if (cluster === CUSTOM_NETWORK_CLUSTER) {
        if (!cfg.customRpcUrl) throw new Error("Set a Custom RPC URL first");
        network = customNetwork(cfg.customRpcUrl);
      } else {
        network = AVAILABLE_NETWORKS.find((n) => n.cluster === cluster);
      }
      if (!network) throw new Error("Unknown network");
      await saveConfig({ ...cfg, selectedNetwork: network });
      await broadcast("clusterChanged", network as Network);
      return { selectedNetwork: network };
    }

    case "popup_setCustomRpc": {
      const { rpcUrl, select } = (req.params ?? {}) as { rpcUrl?: string; select?: boolean };
      const url = (rpcUrl ?? "").trim();
      if (!url.startsWith("https://") && !url.startsWith("http://")) {
        throw new Error("RPC URL must start with https://");
      }
      const network = customNetwork(url);
      const next: PersistedConfig = {
        ...cfg,
        customRpcUrl: url,
        selectedNetwork: select === false ? cfg.selectedNetwork : network,
      };
      await saveConfig(next);
      if (select !== false) await broadcast("clusterChanged", network as Network);
      return { customRpcUrl: url, selectedNetwork: next.selectedNetwork };
    }

    case "popup_getBalance": {
      const { address } = (req.params ?? {}) as { address?: string };
      const target = address ?? cfg.selectedAccount;
      if (!target) throw new Error("No account");
      const conn = await connection();
      const lamports = await conn.getBalance(new PublicKey(target));
      return { address: target, lamports, sol: lamports / 1e9 };
    }

    case "popup_sendSol": {
      const { from, to, sol } = (req.params ?? {}) as {
        from?: string;
        to?: string;
        sol?: number;
      };
      const fromAddr = from ?? cfg.selectedAccount ?? accountAddresses()[0];
      if (!fromAddr) throw new Error("No source account");
      const signature = await executeSendSol(fromAddr, to ?? "", sol ?? 0);
      return { signature };
    }

    case "popup_setAgentMode": {
      const { enabled } = (req.params ?? {}) as { enabled?: boolean };
      await saveConfig({ ...cfg, agentMode: Boolean(enabled) });
      return { agentMode: Boolean(enabled) };
    }

    case "popup_listActions":
      return { pendingActions: pendingViews() };

    case "popup_approveAction": {
      const { id } = (req.params ?? {}) as { id?: string };
      if (!id) throw new Error("id required");
      await approveAction(id);
      return { ok: true, pendingActions: pendingViews() };
    }

    case "popup_declineAction": {
      const { id } = (req.params ?? {}) as { id?: string };
      if (!id) throw new Error("id required");
      declineAction(id);
      return { ok: true, pendingActions: pendingViews() };
    }

    case "popup_deleteAuthorizedOrigin": {
      const { origin } = (req.params ?? {}) as { origin?: string };
      await saveConfig({
        ...cfg,
        authorizedOrigins: cfg.authorizedOrigins.filter((o) => o !== origin),
      });
      return { authorizedOrigins: (await loadConfig()).authorizedOrigins };
    }

    case "popup_setHelmsmanApi": {
      const { apiUrl } = (req.params ?? {}) as { apiUrl?: string };
      const helmsmanApiUrl = String(apiUrl ?? "").trim().replace(/\/$/, "");
      if (!helmsmanApiUrl) throw new Error("API URL required");
      await saveConfig({ ...cfg, helmsmanApiUrl });
      return { helmsmanApiUrl };
    }

    default:
      throw new Error(`Unknown popup method: ${(req as PopupRequest).method}`);
  }
}

// ---- Helmsman agent relays (preserve window.helmsman behavior) ----

async function handleHelmsmanRelay(msg: {
  type: string;
  payload?: unknown;
}): Promise<unknown> {
  switch (msg.type) {
    case "health": {
      const API = await helmsmanApi();
      return (await fetch(`${API}/api/health`)).json();
    }
    case "computer": {
      const API = await helmsmanApi();
      return (await fetch(`${API}/api/computer`)).json();
    }
    case "sign": {
      const API = await helmsmanApi();
      return (
        await fetch(`${API}/api/sign/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload),
        })
      ).json();
    }
    case "pay": {
      const API = await helmsmanApi();
      return (
        await fetch(`${API}/api/pay/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload),
        })
      ).json();
    }
    case "vision": {
      // Agent eyes: capture the current visible tab and analyze it for trading.
      const payload = (msg.payload ?? {}) as { note?: string };
      let dataUrl: string;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: 70 });
      } catch (err) {
        return { error: `screen capture failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const API = await helmsmanApi();
      return (
        await fetch(`${API}/api/vision/trade`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: dataUrl, note: payload.note }),
        })
      ).json();
    }
    default:
      return { error: "unknown" };
  }
}

// ---- Message router ----

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  void (async () => {
    try {
      if (msg?.type === "solana:request") {
        const origin = sender.origin ?? (sender.url ? new URL(sender.url).origin : "unknown");
        const result = await handleProviderRequest(
          msg as ProviderRequest,
          origin,
          sender.tab?.id,
        );
        sendResponse({ result });
        return;
      }
      if (msg?.type === "popup:request") {
        const result = await handlePopupRequest(msg as PopupRequest);
        sendResponse({ result });
        return;
      }
      // Legacy Helmsman agent relay (health/computer/sign/pay).
      sendResponse(await handleHelmsmanRelay(msg));
    } catch (err) {
      const e = err as { code?: number; message?: string };
      sendResponse({ error: { code: e.code, message: e.message ?? String(err) } });
    }
  })();
  return true;
});

// Try to restore an unlocked session across SW restarts (best-effort, dev).
chrome.windows?.onRemoved?.addListener((id) => {
  if (id === notificationWindowId) notificationWindowId = null;
});
