# Clawd Wallet — Chrome Web Store listing

## Store listing copy
**Name:** Clawd Wallet
**Short description (132 chars max):** Clawd Wallet for Solana: you approve every connection, signature and transfer. Keys stay on your device.
**Detailed description:**
Clawd Wallet is the Solana-native extension for the SolGPT trading desk and Helmsman agentic wallet.

- Connect as `window.solana` for swaps and computer-use sessions
- Signing and transfers require approval in the wallet popup
- Works with any dApp through the Wallet Standard, even when another wallet already owns `window.solana`
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

## Single purpose
Clawd Wallet is a Solana wallet: it holds the user's Solana keys locally and lets websites request connections, signatures and transfers, each of which the user approves in the wallet popup.

## Permission justifications (least privilege)
| Permission | Why |
|---|---|
| `storage` | Encrypted vault, settings, per-site approvals and auto-approve sessions in `chrome.storage.local` / `.session`. |
| Content scripts on `http://*/*`, `https://*/*` (`document_start`, one MAIN-world script, top frame only) | Expose the Wallet Standard wallet and `window.solana` so any Solana dApp can find the wallet. The script only relays requests to the background; it reads no page content. |
| Host permissions `https://*/*`, `http://*/*` | Solana JSON-RPC to the network the user selects (incl. a user-entered custom RPC), simulation for the transaction preview, the optional AI assistant endpoint, and reading tab origins so wallet events go only to sites the user approved. |

Not requested: `tabs`, `scripting`, `activeTab`, `webRequest`, `cookies`, `history`, `clipboard*`, `notifications`, remote code. 0.5.2 dropped redundant host entries already covered by `https://*/*`.

## Privacy practices (data disclosure)
- Keys and the recovery phrase are generated and stored encrypted on the device; they are never sent anywhere, including the AI assistant.
- No analytics, no tracking, no sale or transfer of user data.
- Network requests: Solana RPC (public addresses, signed transactions the user approved, simulations) and, only when the user asks the assistant a question, that question to the configured assistant endpoint. The assistant cannot sign or send.
- Website data seen by the wallet: the requesting site's origin and the transaction/message it asks to sign, shown to the user for approval.
- Automatic payments (HTTP 402) and screenshots are disabled.

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

## Release notes
### 0.5.3 (2026-10-21)
- Maintenance rebuild of 0.5.2 for the store: version bump, fresh `dist/` and zip.
- No permission, host permission or content-script changes (still `storage` + `http(s)://*/*`).
- Tests: 62 security/Wallet Standard + 9 unit tests pass; keyring and clawd vectors pass.
