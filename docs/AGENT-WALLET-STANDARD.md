# Agent Wallet Standard (proposal)

Status: **draft proposal** by Clawd Wallet, open for adoption by any Wallet Standard wallet. It is not part of the official Wallet Standard and has not been reviewed, endorsed or verified by the Wallet Standard maintainers, Solana Foundation, or anyone else.

## Goal
AI agents increasingly drive dApps for people. Agents need to know what a wallet will and won't do, and to ask for narrowly scoped, time-limited permission, **without** any path to silent signing. This proposal adds two namespaced features on top of the [Wallet Standard](https://github.com/wallet-standard/wallet-standard). Wallets that don't support them simply don't list them; apps must feature-detect.

Design rules
1. A human approves every grant. No feature here may sign, send, or widen permissions without an approval UI in the wallet.
2. Read-only first. Discovery (`clawd:capabilities`) grants nothing and never prompts.
3. Limits are enforced by the wallet, not trusted from the app. Anything outside a session's limits falls back to normal per-request approval.
4. Sessions are per origin, expire, and end when the wallet locks or the user revokes them.

## `clawd:capabilities` (implemented in Clawd Wallet 0.5.2)
```ts
type ClawdCapabilitiesFeature = {
  'clawd:capabilities': {
    version: '1.0.0';
    getCapabilities(): Promise<{
      humanApprovalRequired: true;
      silentSigning: false;
      transactionPreview: boolean;
      riskWarnings: readonly string[];      // codes that always force manual review
      autoApprove: {
        available: boolean; perSite: true; userInitiatedOnly: boolean;
        limits: readonly ('expiry' | 'maxTotalSol' | 'maxSolPerTx' | 'allowedPrograms')[];
        endsOnLock: boolean;
      };
      agentSession: { available: boolean; spec: string };
      legacyBackendCommands: 'disabled' | 'enabled';
      automaticPayments: boolean;
    }>;
  };
};
```
Rules: no prompt, no account data, same answer for every origin (no fingerprinting beyond the wallet's existence), frozen result.

Usage:
```ts
const cap = await wallet.features['clawd:capabilities']?.getCapabilities();
if (cap && !cap.silentSigning) { /* plan for a human approval per request or a session */ }
```

## `clawd:agentSession` (specified, not yet implemented)
An agent asks for a scoped session. The wallet shows an approval screen listing every limit; the user can tighten (never widen) them before approving.
```ts
type ClawdAgentSessionFeature = {
  'clawd:agentSession': {
    version: '1.0.0';
    request(input: {
      account: WalletAccount;
      chain: 'solana:mainnet' | 'solana:devnet' | 'solana:testnet';
      expiresInSeconds: number;            // wallet caps (Clawd: max 4h)
      maxTotalLamports: bigint | string;   // across the whole session
      maxLamportsPerTransaction: bigint | string;
      allowedPrograms: readonly string[];  // base58 program ids
      purpose: string;                     // shown verbatim to the user, max 200 chars
    }): Promise<{ sessionId: string; expiresAt: number; granted: /* possibly tightened */ object }>;
    status(sessionId: string): Promise<{ active: boolean; spentLamports: string; expiresAt: number }>;
    revoke(sessionId: string): Promise<void>;
  };
};
```
Wallet obligations
- Requires an already-connected origin and an approval popup; `request` rejects if the user declines or the popup is closed (error code 4001).
- While active, a `solana:signTransaction` / `solana:signAndSendTransaction` call is auto-approved **only** if the wallet's own simulation succeeds, every invoked program is in `allowedPrograms`, the SOL outflow fits both caps, and no risk warning fires (authority/owner changes, closes to other owners, token approvals or delegations, durable nonces, unresolved lookup tables, simulation failure). Otherwise the normal approval popup appears.
- `solana:signMessage` and `solana:signIn` are never covered by a session.
- Sessions end on expiry, lock, revoke, or disconnect, and are listed in the wallet UI with a one-click revoke.
- Clawd Wallet's existing per-site auto-approve already enforces these limits; `agentSession` would expose the same mechanism to apps programmatically, with the same mandatory approval.

## Compliance self-check
Clawd Wallet runs `tests/wallet-standard-compliance.test.mjs`, which checks the Wallet/WalletAccount shapes, feature names and versions, `standard:events` change semantics, the read-only capabilities feature, and safe injection when another wallet owns `window.solana`. These are the project's own tests, not a certification.

## License
This document is offered under Apache-2.0, like the Wallet Standard.
