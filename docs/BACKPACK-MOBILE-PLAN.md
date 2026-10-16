# Clawd Wallet × Backpack × Mobile — Plan (2026-10-16)

Research/planning only. No code changed. Sources: `clawd-wallet` v0.4.1 (`src/`, README, SECURITY.md, CHROME-STORE.md),
`~/Downloads/clawd-on-desk/backpack`, `~/Downloads/agent-mail/mobile`.

## 0. License — read first (BLOCKING for copy-paste)
- Backpack root `LICENSE` = **GNU GPL-3.0**. Per-package `package.json` fields say ISC/MIT, but only
  `packages/wallet-standard` ships its own `LICENSE` (**Apache-2.0**). Treat everything except
  `wallet-standard` as **GPL-3.0** (the repo-level license governs; the package.json fields are unreliable).
- Copying GPL code into Clawd Wallet makes the **whole distributed extension/app GPL-3.0**: full source must be
  published under GPL, with no added restrictions.
- **Apple App Store vs GPL**: Apple's ToS adds usage restrictions (DRM, device limits) that the FSF says conflict with GPL
  (VLC was pulled in 2011). Shipping GPL-derived code on iOS is legally risky unless you hold all the copyrights.
- **Recommendation**: do a **clean-room reimplementation** of features. Use Backpack only as a
  behavioural reference (read it, don't paste it). Copy only `packages/wallet-standard` (Apache-2.0: keep NOTICE/LICENSE,
  credit Coral). Prefer MIT/Apache upstreams that Backpack itself uses: `@solana/wallet-standard*`, `@wallet-standard/*`,
  `@solana-mobile/*` (Apache-2.0), `@ledgerhq/*` (Apache/MIT), Jupiter API.
- Decide Clawd Wallet's own license explicitly (currently none stated in the README; add a LICENSE file).

## 1. Backpack inventory
| Package | What it does | License | Use |
|---|---|---|---|
| `wallet-standard` | Registers Backpack as a Wallet Standard wallet (`register.ts`, `wallet.ts`, `solana.ts`: connect/signTx/signMsg/signAndSend/signIn features) | Apache-2.0 | **Port** (attribution) |
| `provider-core`, `provider-injection` | `window.backpack`/`window.solana` injected provider + content-script bridge | GPL | Reference only |
| `secure-background` | Keyring (`BlockchainKeyring`, HD derivation, **ledger.ts**), svm/evm/ledger/user services, notifications, store, transports | GPL | Reference |
| `secure-clients` | `SolanaClient`, `EthereumClient`, `TensorClient` (NFT), blockchain client base | GPL | Reference |
| `secure-ui` | Approval/consent UI; Ledger via WebHID + **React Native BLE** transport | GPL | Reference |
| `app-extension` | MV3 extension shell (Solana + Ethereum) | GPL | Reference |
| `background` | Legacy background script | GPL | Skip |
| `recoil`, `react-common`, `data-components`, `tamagui-core` | State, shared React, token/NFT/activity components, Tamagui cross-platform UI (web + RN) | GPL (pkg says MIT) | Pattern reference |
| `i18n` | Locale strings (Airtable sync) | GPL | Reimplement with i18next |
| `staking` | SOL native staking hooks + button | GPL | Reference |
| `expo-devtools` | Expo dev plugin — evidence the mobile app was **Expo/React Native** | GPL | — |
| `xnft-cli`, `examples/xnft/*` | xNFT (deprecated by Backpack in 2024) | GPL | **Skip** |
| `web` | Next.js site | GPL | Skip |
| `scripts` | Monorepo depcheck/release/expo dep sync | GPL | Ideas only |
- **Missing**: the `app-mobile` package is referenced by `start:mobile` but is **not in this checkout**. No mobile source to reuse.
- Swap UI and the GraphQL token/NFT/activity backends depend on Backpack's hosted APIs. These are not usable; plan to use Jupiter/Helius/DAS instead.

## 2. Gap analysis (ranked)
Clawd today: window.solana/window.clawd injection, per-request consent, BIP39/BIP32 hardened keyring, PBKDF2+AES-GCM vault,
Clawd Chain (PoW faucet, names), AI assistant via Cloudflare proxy, request-policy. No Wallet Standard yet.

| # | Feature | Effort | Approach |
|---|---|---|---|
| 1 | **Wallet Standard registration** (`standard:connect/events`, `solana:signTransaction/signMessage/signAndSendTransaction/signIn`, chains `solana:mainnet` + custom `clawd:testnet`) | S | Port Backpack `wallet-standard` (Apache) or `@solana/wallet-standard-wallet-adapter-base`; wire into `injected.ts` |
| 2 | **Transaction simulation/preview** (balance diffs, writable accounts, program names, warnings) before Approve | M | Reimplement: `simulateTransaction` + parse; feeds consent UI |
| 3 | **Token list & balances** (SPL + Token-2022, prices, metadata) | M | Reimplement via Helius/DAS `getAssetsByOwner` + Jupiter price |
| 4 | **Activity history** | S–M | `getSignaturesForAddress` + Helius parsed tx |
| 5 | **Multiple accounts / derivation paths / import private key** | M | Extend `wallet/keyring.ts`; Backpack keyring as reference |
| 6 | **Swap** (Jupiter Ultra/Swap API) | M | Reimplement; region gating/disclaimers (see §3) |
| 7 | **NFT gallery** (incl. cNFT) | M | DAS API |
| 8 | **Address book + name resolution** (.sol / Clawd names) | S | Reimplement; `clawd/names.ts` exists |
| 9 | **Ledger** (WebHID ext / BLE mobile) | L | `@ledgerhq/hw-app-solana` directly |
| 10 | **SOL staking** | M | Reimplement on stake program / validators list |
| 11 | **Notifications** (tx confirmed, incoming) | S–M | chrome.notifications; push later on mobile |
| 12 | i18n (worldwide) | M | i18next; extract strings early |
| — | Ethereum/EVM, xNFT | — | **Skip** (scope + xNFT dead) |

## 3. Mobile path
### Architecture
- Monorepo (pnpm/turbo): `packages/core` (pure TS: keyring, vault crypto, tx building/simulation parse, Clawd Chain,
  request-policy, Wallet Standard types), `apps/extension` (current Vite code), `apps/mobile` (**Expo + React Native**, dev client
  / prebuild, not Expo Go). The UI is per platform. Optionally use Tamagui later; don't block on it.
- Mobile crypto: `react-native-quick-crypto` (or `@noble/*`), CSPRNG via `expo-crypto`. Keys go in **iOS Keychain / Android Keystore**
  (`expo-secure-store` + biometric gate) instead of chrome.storage.
- AI assistant keeps going through the Cloudflare proxy. It must never see keys (same as SECURITY.md).

### Solana Mobile (Seeker / dApp Store)
- **Wallet-side MWA**: Clawd must act as a *wallet*, not a dApp. The existing agent-mail app is dApp-side, so this is new work. Use
  `@solana-mobile/mobile-wallet-adapter-walletlib` (RN) to handle `solana-wallet://` association intents, authorize/
  reauthorize/deauthorize, sign_transactions, sign_and_send, sign_messages, and Sign-In-With-Solana. Show the same consent UI.
- **Seed Vault** (Seeker/Saga): offer "Use Seed Vault" accounts via the Seed Vault SDK (Android native module, `com.solanamobile.seedvault`).
  Keys never leave secure hardware, and signing goes through the Seed Vault UI. Keep the local-key option as a fallback.
- **dApp Store**: publish with `@solana-mobile/dapp-store-cli`. You need a publisher NFT, an app NFT, and a release NFT per version.
  Each release is a signed APK (not AAB), with its own signing key (different from Play's upload key), listing assets and a privacy policy and terms URL.
  The store is crypto-friendly and has no 30% fee.
- **Reuse from `agent-mail/mobile`**: release/verification checklists (`submission-checklist.json`, `RELEASE.md`,
  `PUBLISHER-VERIFICATION.md`, `REVIEWER-ACCESS.md`, `VERIFICATION.md`), `store-listing.json` schema, apksigner/zipalign/
  aapt2 verification steps, Seeker physical-device check list (MWA authorize, reject/retry, disconnect/reconnect, return-to-app).
  The publisher profile there is still `profileVerified: false`. Finish verifying it once and reuse the same publisher for
  Clawd Wallet. Do **not** reuse its TWA/WebView shell or the `app.clawdmail.mobile` signing key. Make a new package, e.g. `trade.clawd.wallet`.

### Google Play
- Self-custody wallets are allowed. Fill the **Financial features declaration** (non-custodial wallet). Some regions require
  licensing for custodial/exchange services. Since Clawd is non-custodial, keep swaps routed through a third party (Jupiter), with disclosures.
- Organization developer account (D-U-N-S) is strongly advised. New personal accounts face a 12-tester/14-day closed test.
  Requirements: target the current API level, Data Safety form, privacy policy URL, account deletion (N/A if no accounts), and a 16 KB page-size check.
- Use geo-restriction for sanctioned countries. Run OFAC screening of swap counterparties via the provider.

### Apple App Store
- Guideline 3.1.5: wallets are allowed **only from an organization** developer account (not individual). Crypto exchange-like
  features (swap) need licensing in the regions where they're offered. Use per-country availability and disable swap in restricted regions.
  NFTs may be shown, but unlocking features with NFTs or crypto (4.7/3.1.1) is not allowed. Rewards for downloads or for faucet/PoW mining are not allowed
  (2.4.2 / 3.1.5(ii): **on-device mining is banned**, so the Clawd Chain PoW faucet must be **disabled or server-side on iOS**).
- Also required: privacy nutrition labels, privacy policy URL, export compliance (encryption; standard crypto exemption usually applies),
  Sign-in not required. Reviewers will need a demo flow (a testnet wallet).
- GPL conflict (see §0). Another reason to clean-room.

### Worldwide disclosures (all stores)
Non-custodial notice ("we can't recover your seed"), risk warning, no investment advice, swap provider + fees disclosed,
AI-assistant disclaimer, test-network tokens have no value, sanctions/restricted-jurisdiction terms.

## 4. Roadmap
**Phase 1 — Extension completeness (≈3–5 wks)**
- Add LICENSE + NOTICE. Do a license audit and write a clean-room policy doc.
- Wallet Standard registration (mainnet + Clawd Chain), tested with the wallet-adapter test dApp + Playwright.
- Tx simulation preview in consent popup. Add token balances, activity, address book, and multiple accounts.
- Extract `packages/core` from `src/wallet`, `src/clawd`, `src/request-policy.ts` (no behaviour change, tests ported).
- Ship to the Chrome Web Store as 0.5.0 (update CHROME-STORE.md).

**Phase 2 — Android + Solana Mobile (≈5–8 wks)**
- Expo app (`apps/mobile`) on `core`. Secure storage + biometrics, onboarding/import, send/receive, tokens, activity.
- Wallet-side MWA (walletlib) + Seed Vault accounts. Run the Seeker device checklist (reused from agent-mail).
- Signed APK through `dapp-store-cli` (publisher/app/release NFTs), then submit to the dApp Store.
- Swap (Jupiter) + NFT gallery behind feature flags. Closed test in Google Play, then the Play production rollout.

**Phase 3 — iOS + worldwide (≈4–6 wks)**
- iOS build (EAS), PoW faucet disabled, swap region-gated. App Store review with a demo account/testnet.
- Ledger (WebHID extension, BLE mobile), staking, push notifications, i18n (top 8 languages).
- Optional third-party security audit before marketing 1.0.

## 5. Only the user can provide
- **Legal entity** (LLC/Ltd) + D-U-N-S number, which Apple wallets require and Play recommends.
- **Apple Developer Program (Organization, $99/yr)** and **Google Play Console (org, $25)**. Solana dApp Store publisher wallet + SOL for NFT minting. Verify the publisher profile.
- **Signing keys**: a new Android keystore for the dApp Store APK, a Play upload key (Play App Signing), Apple certs/profiles (EAS can manage them). Back these up offline.
- **Privacy policy + Terms URLs** (e.g. `clawd.trade/privacy`), support email, and a decision on the restricted-jurisdiction list.
- **License decision** for Clawd Wallet (MIT/Apache vs GPL) and sign-off on clean-room-only use of Backpack code.
- Store assets (screenshots per device, icon, feature graphic), a physical Seeker for testing, and API keys (Helius, Jupiter).
- Legal review of swap/AI features per region (counsel).
