// Shared protocol constants and types for the Helmsman Solana wallet extension.
// Message flow:
//   dapp page  <-window.postMessage->  content script  <-chrome.runtime->  background (service worker)
//   popup      <----------------- chrome.runtime.sendMessage --------------> background

export const SOLANA_REQUEST_CHANNEL = "helmsman-solana";
export const SOLANA_REPLY_CHANNEL = "helmsman-solana-reply";
export const SOLANA_EVENT_CHANNEL = "helmsman-solana-event";

// Legacy Helmsman agent channel (window.helmsman), preserved.
export const HELMSMAN_CHANNEL = "helmsman";
export const HELMSMAN_REPLY_CHANNEL = "helmsman-reply";

// Provider RPC methods. The first four match the referenced Solana extension's
// `WallActions` exactly; the rest are Helmsman additions.
export type WalletMethod =
  | "wallet_getState"
  | "wallet_getCluster"
  | "wallet_requestAccounts"
  | "wallet_signTransaction"
  | "wallet_signAllTransactions"
  | "wallet_signMessage"
  // Computer-use / agent additions:
  | "wallet_signAndSendTransaction"
  | "wallet_signTransactionB64"
  | "wallet_sendSol"
  | "wallet_getBalance";

export type WalletState = "locked" | "unlocked" | "uninitialized";

export type Network = {
  title: string;
  cluster: string;
  endpoint: string;
};

export const AVAILABLE_NETWORKS: Network[] = [
  {
    title: "Mainnet Beta",
    cluster: "mainnet-beta",
    endpoint: "https://api.mainnet-beta.solana.com",
  },
  { title: "Devnet", cluster: "devnet", endpoint: "https://api.devnet.solana.com" },
  { title: "Testnet", cluster: "testnet", endpoint: "https://api.testnet.solana.com" },
];

/** User-owned HTTPS JSON-RPC; endpoint comes from PersistedConfig.customRpcUrl. */
export const CUSTOM_NETWORK_CLUSTER = "custom";

export function customNetwork(endpoint: string): Network {
  return { title: "Custom RPC", cluster: CUSTOM_NETWORK_CLUSTER, endpoint };
}

export const DEFAULT_NETWORK: Network = AVAILABLE_NETWORKS[0]; // Mainnet Beta

export type SignatureResult = { publicKey: string; signature: string };
export type SignTransactionResp = { signatureResults: SignatureResult[] };
export type RequestAccountsResp = { accounts: string[] };

// Notifications broadcast to dapps (match reference event names).
export type ProviderEvent =
  | "stateChanged"
  | "accountsChanged"
  | "clusterChanged"
  | "disconnected";

// ---- Background message envelopes ----

export type ProviderRequest = {
  type: "solana:request";
  id: string;
  method: WalletMethod;
  params?: unknown;
};

export type PopupMethod =
  | "popup_getState"
  | "popup_createWallet"
  | "popup_restoreWallet"
  | "popup_unlockWallet"
  | "popup_lockWallet"
  | "popup_addAccount"
  | "popup_selectAccount"
  | "popup_changeNetwork"
  | "popup_getBalance"
  | "popup_sendSol"
  | "popup_listActions"
  | "popup_approveAction"
  | "popup_declineAction"
  | "popup_deleteAuthorizedOrigin"
  | "popup_setAgentMode"
  | "popup_setHelmsmanApi"
  | "popup_setCustomRpc";

export type PopupRequest = {
  type: "popup:request";
  id: string;
  method: PopupMethod;
  params?: unknown;
};

export type PendingActionType =
  | "request_accounts"
  | "sign_transaction"
  | "sign_message"
  | "sign_and_send"
  | "sign_b64"
  | "send_sol";

export type PendingActionView = {
  id: string;
  type: PendingActionType;
  origin: string;
  tabId?: number;
  // sign_transaction / sign_message
  message?: string;
  signers?: string[];
  // sign_and_send
  transaction?: string;
  // send_sol
  to?: string;
  amountSol?: number;
};

export type PopupState = {
  walletState: WalletState;
  accounts: string[];
  selectedAccount: string | null;
  selectedNetwork: Network;
  availableNetworks: Network[];
  authorizedOrigins: string[];
  pendingActions: PendingActionView[];
  agentMode: boolean;
  helmsmanApiUrl: string;
  customRpcUrl: string;
};
