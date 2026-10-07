import { DEFAULT_NETWORK, type Network } from "../protocol.js";
import type { EncryptedVault } from "./vault.js";

export type PersistedConfig = {
  accountCount: number;
  selectedAccount: string | null;
  selectedNetwork: Network;
  authorizedOrigins: string[];
  // Computer-use / agent mode: auto-approve provider requests from authorized
  // origins so an autonomous agent can transact without manual popup clicks.
  agentMode: boolean;
  /** Helmsman control-plane API (site the user downloaded the extension from). */
  helmsmanApiUrl?: string;
  /** User Solana JSON-RPC (e.g. Helius). Prefer chrome.storage; may seed from config.json. */
  customRpcUrl?: string;
};

const VAULT_KEY = "helmsman:vault";
const CONFIG_KEY = "helmsman:config";
const SESSION_KEY = "helmsman:unlocked";

export type UnlockedSession = { mnemonic: string; seedHex: string };

// Unlocked secrets live in chrome.storage.session (in-memory, wiped when the
// browser closes, not persisted to disk) so the wallet stays unlocked across
// MV3 service-worker suspensions instead of re-locking every few seconds.
export async function loadSession(): Promise<UnlockedSession | null> {
  const out = await chrome.storage.session.get(SESSION_KEY);
  return (out[SESSION_KEY] as UnlockedSession) ?? null;
}

export async function saveSession(session: UnlockedSession): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: session });
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}

const DEFAULT_CONFIG: PersistedConfig = {
  accountCount: 1,
  selectedAccount: null,
  selectedNetwork: DEFAULT_NETWORK,
  authorizedOrigins: [],
  agentMode: false,
};

export async function loadVault(): Promise<EncryptedVault | null> {
  const out = await chrome.storage.local.get(VAULT_KEY);
  return (out[VAULT_KEY] as EncryptedVault) ?? null;
}

export async function saveVault(vault: EncryptedVault): Promise<void> {
  await chrome.storage.local.set({ [VAULT_KEY]: vault });
}

export async function loadConfig(): Promise<PersistedConfig> {
  const out = await chrome.storage.local.get(CONFIG_KEY);
  return { ...DEFAULT_CONFIG, ...(out[CONFIG_KEY] as Partial<PersistedConfig>) };
}

export async function saveConfig(config: PersistedConfig): Promise<void> {
  await chrome.storage.local.set({ [CONFIG_KEY]: config });
}
