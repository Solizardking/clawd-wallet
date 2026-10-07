# Clawd Wallet — Chrome Web Store listing

## Store listing copy
**Name:** Clawd Wallet
**Short description (132 chars max):** Solana Clawd / SolGPT wallet for agentic trading. Quote before pay (x402). Superintelligent Design. Never stores your seed in chat.
**Detailed description:**
Clawd Wallet is the Solana-native extension for the SolGPT trading desk and Helmsman agentic wallet.

- Connect as `window.solana` for swaps and computer-use sessions
- x402 quote-before-pay (https://x402.life) — staged payments are not settled until you sign
- Desk: https://solgpt.trade
- Brand: Superintelligent Design

Clawd never stores seed phrases, private keys, or passwords in chat or agent memory. Keys stay in the extension’s local storage on your device.

## Required assets (in this repo)
- Icons: `public/icons/icon-16.png`, `icon-48.png`, `icon-128.png`
- Promo / screenshots: `public/brand/solgpt-v2/clawd-ecosystem-banner.png`, `clawd-domains-lockup.png`, `clawd-superdesign-ui-mock.png`
- Homepage: https://solgpt.trade
- Support: https://x402.life

## Publish checklist
1. Chrome Web Store developer account (one-time registration).
2. `npm run pack` to rebuild `dist/` and zip.
3. Upload `helmsman-extension.zip` (or the pack output).
4. Category: Productivity / Developer tools. Regions: public / unlisted as you prefer.
5. Privacy: single purpose (Solana wallet + agent approve). Host permissions are for RPC and x402.
6. Submit for review.

## Load unpacked
1. `npm install && npm run build` (from the repo root)
2. Chrome → `chrome://extensions` → Developer mode on
3. Load unpacked → select the `dist/` folder
4. Pin Clawd Wallet
