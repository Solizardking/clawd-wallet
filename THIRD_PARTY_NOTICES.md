# Third-party notices

Clawd Wallet bundles the following open-source packages in `injected.js`
(Wallet Standard support, added in 0.4.2). They are licensed under the
Apache License, Version 2.0 (https://www.apache.org/licenses/LICENSE-2.0).

| Package | Version | License | Copyright |
| --- | --- | --- | --- |
| `@wallet-standard/wallet` | 1.1.1 | Apache-2.0 | Solana Labs / Wallet Standard contributors |
| `@wallet-standard/base` (types) | 1.1.1 | Apache-2.0 | Solana Labs / Wallet Standard contributors |
| `@wallet-standard/features` (types) | 1.1.1 | Apache-2.0 | Solana Labs / Wallet Standard contributors |
| `@solana/wallet-standard-features` (types) | 1.5.0 | Apache-2.0 | Solana Labs / Wallet Standard contributors |
| `@wallet-standard/app` (tests only, not shipped) | 1.1.1 | Apache-2.0 | Solana Labs / Wallet Standard contributors |
| `@solana/wallet-adapter-react`, `-react-ui`, `-base` (test fixture only, not shipped) | 0.15.40 / 0.9.40 / 0.9.28 | Apache-2.0 | Solana Labs |
| `react`, `react-dom` (test fixture only, not shipped) | 18.3.1 | MIT | Meta Platforms, Inc. |

The transaction preview, auto-approve and SIWS code (`src/tx/`) is original Clawd code.
No source code from the Backpack wallet (Coral, GPL-3.0) is included.
`src/wallet-standard.ts` is an original implementation (0.5.2: account object and
injection pattern aligned with the Apache-2.0 reference wallet in
`wallet-standard/packages/wallets/ghost`, no code copied verbatim) written against the
public Wallet Standard interfaces above; Backpack's Apache-2.0
`packages/wallet-standard` was not copied. Should any Backpack Apache-2.0 code be
ported in future, its license header and a Coral attribution must be added here.

Other runtime dependencies (`@solana/web3.js`, `tweetnacl`, `bip39`, `bs58`,
`@noble/hashes`, `buffer`) keep their own licenses as shipped in `node_modules`.
