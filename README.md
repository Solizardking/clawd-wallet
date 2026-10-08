# Clawd Wallet (Chrome extension)

Solana-native Clawd / SolGPT wallet + computer-use agent surface for Chrome (Manifest V3):
`window.solana` provider, agent auto-approve mode, voice trading, and x402 auto-pay.

- Version: **0.3.0**
- Desk: https://solgpt.trade · x402: https://x402.life

## Install (no build needed)

**Option A: release zip**

1. Download `clawd-wallet-v0.3.0.zip` from the [latest release](../../releases/latest) and unzip it.
2. Open `chrome://extensions` in Chrome (or any Chromium browser: Brave, Edge, Arc).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the unzipped `dist` folder (the one containing `manifest.json`).
5. Pin **Clawd Wallet** from the puzzle-piece menu.

**Option B: clone**

```bash
git clone https://github.com/Solizardking/clawd-wallet.git
```

Then do steps 2–5 above and select the repo's `dist/` folder. `dist/` is committed and ready to load.

## Build from source

Requires Node 18+ (tested on Node 20).

```bash
npm install
npm run build        # outputs the extension to dist/
npm run typecheck    # optional: TypeScript check
npm run test:keyring # optional: verify BIP39/BIP32 derivation against reference vectors
npm run pack         # optional: build + write helmsman-extension.zip
```

`npm run pack` writes `dist/config.json` from env vars:

- `HELMSMAN_PUBLIC_URL`: agent/backend API URL (default `http://localhost:8787`)
- `HELMSMAN_RPC_URL`: optional custom Solana RPC URL

With no `rpcUrl` configured, the wallet uses the public `https://api.mainnet-beta.solana.com` endpoint.
You can also set a custom RPC and backend URL from the popup's settings. Don't commit an RPC URL
that has a private API key in it.

## Permissions and why

| Permission | Why |
| --- | --- |
| `storage` | Saves your encrypted vault, accounts, network and settings locally on your device. |
| `activeTab`, `tabs` | Finds which site is asking to connect or sign, so approvals show the right origin. |
| Content script on `http://*/*`, `https://*/*` | Injects the `window.solana` provider so dapps can detect and connect to the wallet. |
| `injected.js` web-accessible resource | The provider script that's injected into the page. |
| Host permissions `https://*/*`, `http://*/*`, `http://localhost:8787/*` | Talks to the Solana RPC you choose, the Helmsman/agent backend, and x402 payment endpoints. |

## Project layout

```
public/      manifest.json, popup.html, icons, config.json, brand assets
src/         background (service worker), content, injected provider, popup, wallet (keyring/vault)
scripts/     pack + zip helpers
dist/        built, load-unpacked-ready extension
```

## Security

This is a wallet. It's self-custodial:

- Your seed phrase is created on your device and stored encrypted with your password (WebCrypto) in
  the extension's local storage. Nobody else has a copy.
- **Never share your seed phrase or password** with anyone: not a website, a support account, or an AI
  agent. No legitimate service will ask for it.
- Agent auto-approve mode signs without asking you each time. Turn it on only for agents and sites you
  trust, and keep only small balances in a wallet that has it turned on.
- Back up your seed phrase offline. If you lose it, nobody can recover the wallet.
- This is unaudited, pre-1.0 software. Use at your own risk.
- **AI-accelerated cryptanalysis:** see [SECURITY.md](SECURITY.md) for the full posture. The short version:
  key derivation and vault encryption are hash-based (no exploitable mathematical structure);
  signing is Ed25519 because Solana requires it; there are zero lattice-based constructions in the
  wallet. Do not rush to move funds — use fresh addresses when convenient, and for multisig setups
  gather confirmations offchain where possible.

`src/wallet/keyring.vectors.ts` contains a **public test mnemonic** from a reference extension's
test suite. It's only there to check derivation. Never send funds to it.
