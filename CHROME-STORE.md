# Clawd Wallet — Chrome Web Store listing

## Store listing copy
**Name:** Clawd Wallet
**Short description (132 chars max):** Clawd Wallet for Solana: you approve every connection, signature and transfer. Keys stay on your device.
**Detailed description:**
Clawd Wallet is the Solana-native extension for the SolGPT trading desk and Helmsman agentic wallet.

- Connect as `window.solana` for swaps and computer-use sessions
- Signing and transfers require approval in the wallet popup
- Legacy backend payments, signing and screenshot commands are disabled pending a secure consent flow
- Desk: https://solgpt.trade
- Transaction preview with SOL/token balance changes and risk warnings before you sign
- Optional per-site auto-approve sessions with spend limits; locking ends every session
- Ecosystem: https://clawdchain.trade · https://musebook.trade
- Superintelligent Design

Clawd never stores seed phrases, private keys, or passwords in chat or agent memory. Keys stay in the extension’s local storage on your device.

## Required assets (in this repo)
- Icons: `public/icons/icon-16.png`, `icon-48.png`, `icon-128.png`
- Screenshots (1280x800): `store-assets/0.5.1/screenshot-1..5.png`
- Small promo tile (440x280): `store-assets/0.5.1/promo-small-440x280.png`
- Marquee (1400x560): `store-assets/0.5.1/marquee-1400x560.png`
- Homepage: https://clawdchain.trade/
- Support: https://musebook.trade/

## Publish checklist
1. Chrome Web Store developer account (one-time registration).
2. `npm run pack` to rebuild `dist/` and zip.
3. Upload `helmsman-extension.zip` (or the pack output).
4. Category: Productivity / Developer tools. Regions: public / unlisted as you prefer.
5. Privacy: single purpose (Solana wallet with explicit approval). Host permissions are for RPC. Automatic payments and screenshots are disabled.
6. Submit for review.

## Load unpacked
1. `npm ci && npm run build` (from the repo root)
2. Chrome → `chrome://extensions` → Developer mode on
3. Load unpacked → select the `dist/` folder
4. Pin Clawd Wallet
