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

No source code from the Backpack wallet (Coral, GPL-3.0) is included.
`src/wallet-standard.ts` is an original implementation written against the
public Wallet Standard interfaces above; Backpack's Apache-2.0
`packages/wallet-standard` was not copied. Should any Backpack Apache-2.0 code be
ported in future, its license header and a Coral attribution must be added here.

Other runtime dependencies (`@solana/web3.js`, `tweetnacl`, `bip39`, `bs58`,
`@noble/hashes`, `buffer`) keep their own licenses as shipped in `node_modules`.
