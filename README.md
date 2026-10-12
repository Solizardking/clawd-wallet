# Clawd Wallet (Chrome extension)

Solana-native Clawd / SolGPT wallet + computer-use agent surface for Chrome (Manifest V3):
`window.solana` provider with explicit approval for connections, signing and transfers.
Legacy backend payments, backend signing and screenshot commands are disabled until
a secure per-request consent flow is implemented. HTTP 402 responses pass through unchanged.

- Version: **0.3.1** (local consent fix)
- Desk: https://solgpt.trade · x402: https://x402.life

## Install (no build needed)

**Use the rebuilt local extension**

1. Use this checkout's rebuilt `dist/` folder, or unzip the locally generated `helmsman-extension.zip`.
2. Open `chrome://extensions` in Chrome (or any Chromium browser: Brave, Edge, Arc).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select `dist/` or the unzipped `helmsman-extension/` folder containing `manifest.json`.
5. Pin **Clawd Wallet** from the puzzle-piece menu.

The published v0.3.0 release predates this fix. This patch does not install the extension in
your normal browser profile or publish a new GitHub release.

**Clone and build**

```bash
git clone https://github.com/Solizardking/clawd-wallet.git
cd clawd-wallet
npm ci
npm run build
```

Follow the install steps above after the consent fix is present in your checkout.

## Build from source

Requires Node 20.19+ or 22.12+ (the Vite requirement).

```bash
npm ci
npm run build        # outputs the extension to dist/
npm run typecheck    # TypeScript check
npm test             # rebuilt-bundle consent regressions + public derivation vectors
npx playwright install chromium # once, if the test browser is not installed
npm run test:browser # consent UI in a disposable Chromium profile
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
| `activeTab`, `tabs` | Existing tab permissions; sender metadata identifies the requesting site. Screenshot commands are disabled. |
| Content script on `http://*/*`, `https://*/*` | Injects the `window.solana` provider so dapps can detect and connect to the wallet. |
| `injected.js` web-accessible resource | The provider script that's injected into the page. |
| Host permissions `https://*/*`, `http://*/*`, `http://localhost:8787/*` | Lets the wallet talk to the Solana RPC you choose. Legacy backend payment/signing relays are disabled. |

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
- New site connections, signing and transfers require approval in the wallet popup.
  Previously persisted agent auto-approve settings are ignored.
- Webpages cannot invoke popup management or approval commands. Legacy `pay`, `sign`, `vision`,
  `computer` and `health` relays reject before contacting a backend or capturing a screenshot.
- Back up your seed phrase offline. If you lose it, nobody can recover the wallet.
- This is unaudited, pre-1.0 software. Use at your own risk.
- **AI-accelerated cryptanalysis:** see [SECURITY.md](SECURITY.md) for the full posture. The short version:
  key derivation and vault encryption are hash-based (no exploitable mathematical structure);
  signing is Ed25519 because Solana requires it; there are zero lattice-based constructions in the
  wallet. Do not rush to move funds — use fresh addresses when convenient, and for multisig setups
  gather confirmations offchain where possible.

`src/wallet/keyring.vectors.ts` contains a **public test mnemonic** from a reference extension's
test suite. It's only there to check derivation. Never send funds to it.

See [the consent fix and verification notes](docs/wallet-consent-fix.md) for scope, tests,
and remaining dependency findings.
