# Security posture: AI-accelerated cryptanalysis

Clawd Wallet's stance on the emerging risk that AI accelerates mathematical
cryptanalysis (the "AI-vulnerable cryptography" thesis):

> Take the risks to cryptography from AI-accelerated math seriously, but do not
> scramble to move funds to new wallets. Botched migrations lose more money
> than the hacks they try to preempt.

This document is a statement of design posture, not a promise of future safety.
No one can prove a signature scheme will survive 50 years of math done in 2.

## Crypto inventory

Every primitive the wallet touches, classified by how much "structure" an AI
mathematician could exploit:

| Layer | Primitive | Structure? | Posture |
| --- | --- | --- | --- |
| Signing | Ed25519 (Solana, tweetnacl) | Yes — elliptic curve group | **Exposed surface.** If discrete-log-class attacks improve dramatically, signatures are the risk. Nothing hash-only exists for Solana; this is inherent to the chain. |
| Key derivation | BIP39 seed → HMAC-SHA512 (BIP32, hardened only) | No — hashes | Safe under this thesis. Hashes have no exploitable structure; we pad round counts, not byte sizes. |
| Vault encryption | PBKDF2-SHA256 (600k iterations) → AES-256-GCM | No — hash + symmetric | Safe. Grover-class quantum/AI speedups at most halve effective symmetric bits (256 → 128), still comfortable. |
| Randomness | `crypto.getRandomValues` | — | Platform CSPRNG. |

**We deliberately use zero lattice-based, FHE-based, or ML-DSA constructions.**
No Falcon, no Kyber/ML-KEM, no lattice commitments. Under this thesis,
hash-based constructions outrank lattice-based ones wherever hash-based is
possible; and for lattice-based primitives that can't be avoided, parameter
sizes should be ~10x'd. This wallet has nothing in that category, so nothing
needs upsizing.

## What we changed

- **PBKDF2 iterations: 200,000 → 600,000.** If we ever worry more about
  hashes, the response is to pad round counts first, never byte sizes. The
  vault format (`EncryptedVault`) already stores the iteration count per
  vault, so older vaults still decrypt; new vaults are created at 600k.
  This is a marginal cost on unlock (WebCrypto, ~a second on modern
  hardware) for a marginal hedge — proportionate, not panic.
- **No change to signing.** Ed25519 is dictated by Solana itself. A wallet
  cannot unilaterally "go hash-only" on a chain that verifies Ed25519.
- **No emergency migration tooling.** Deliberately. Rushed key migrations
  are a larger realized-loss risk than the cryptanalytic threat they chase.

## User guidance

1. **Do not move funds today.** No evidence of imminent breakage; a botched
   migration is the historically costlier mistake.
2. **Prefer fresh addresses when it's easy.** "Add account" derives the next
   hardened account (`m/44'/501'/i'/0'`) — no re-derivation of used keys.
   An address whose pubkey has never appeared onchain exposes strictly less
   cryptanalytic surface if group-structure attacks ever improve.
3. **Multisig: confirm offchain where possible.** If you use a multisig
   (e.g. Squads), gather signer confirmations offchain rather than posting
   each signature onchain. If curve cryptography ever degrades unexpectedly,
   this fails closed to "whoever collected the signatures can move funds"
   instead of "anyone can move funds" — a strictly better degradation path.
4. **Keep the seed offline and the password strong.** The vault KDF is the
   one layer entirely under your control; a strong password plus the 600k
   iteration count is what stands between a stolen device and your seed.
5. **Treat "quantum-proof wallet" marketing with suspicion.** Any product
   claiming post-quantum safety via *lattice* primitives is exactly the
   category this thesis warns about. Hash-based claims deserve the most
   attention; everything else, read the parameters.

## Agent mode

Auto-approve mode (`agentMode`) signs without a popup per request. That is a
*convenience* risk, orthogonal to the cryptanalysis risk above — but the
combination matters: an agent signing freely on a long-lived key maximizes
the number of signatures visible onchain. Keep agent-mode wallets funded
with small balances, on fresh accounts, and rotate them freely since no
migration is involved.

## Reporting

This is unaudited, pre-1.0 software. Report security issues via a GitHub
issue; do not include seed phrases, passwords, or private keys in any
report — no legitimate maintainer will ever ask for them.
