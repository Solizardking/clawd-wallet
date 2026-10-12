# Wallet consent fix

The request is to block older webpage commands for automatic backend payments, signing,
and screenshots because they lack per-request consent. Normal Solana requests must retain
their approval flow. Legacy commands require a secure consent flow before re-enablement.

## Implemented behavior

- The legacy `helmsman` webpage channel returns error 4200 locally and forwards no payload.
- The service worker also rejects legacy calls, including messages from stale content scripts.
  The backend payment, signing, computer and screenshot handlers have been removed.
- The injected `clawd` / `helmsman` compatibility methods reject legacy commands. Solana
  aliases still use the ordinary provider. The wallet no longer overrides `window.fetch`.
- Popup commands require Chrome's sender extension ID and the exact wallet popup URL.
  Both action popups and notification windows hosted in extension tabs are supported.
  Sender metadata comes from Chrome, not the webpage payload. See the official
  [MessageSender reference](https://developer.chrome.com/docs/extensions/reference/api/runtime#type-MessageSender).
- Provider requests require a content-script sender with an HTTP(S) page origin. Opaque,
  inconsistent and extension origins are rejected.
- Connection, signing and transfer approval does not bypass the popup, including when an
  earlier installation stored `agentMode=true`. The old mode toggle is disabled.
- Pending approvals include the transaction, transfer recipient and amount. Approval consumes
  each action once, checks the wallet is unlocked and rechecks the site's authorization.
- Approval-window and signing failures reject the request instead of leaving it unresolved.

## Verification

Run `npm run typecheck`, `npm test` and `npm run test:browser`.

The security suite executes the rebuilt service worker, content script and injected provider.
It covers legacy calls, forged popup messages, sender checks, HTTP 402 passthrough, new
connections, every signing/transfer approval path, rejection, approved message/transaction
signatures, site revocation, failed popup creation and malformed transaction requests.

The browser test loads the rebuilt extension into a disposable Chromium profile, checks
the actual connection and message approval/rejection windows, and removes the profile.
It uses a public derivation fixture and mocks RPC balance reads. It never uses a user's
wallet, captures a page, contacts a legacy backend or broadcasts a funded transaction.
Results and UI captures are written to `docs/verification/`.

The extension remains uninstalled in the user's normal browser profile. The patch and
archive are local; the GitHub v0.3.0 release has not been updated.

## Re-enablement requirements

Legacy commands stay disabled. A future implementation must bind each action to the
validated sender origin, show the exact operation in extension-owned UI, require an
explicit decision, and reject stale or reused approvals. Payments need amount, asset,
network and recipient details; signing needs the exact message or transaction; screenshots
need an explicit target and capture decision. A site connection alone grants none of these
permissions.

## Remaining boundary

This is a targeted consent fix, not a full wallet audit. The October 7, 2026 npm audit
reports four existing moderate dependency findings in the `@solana/web3.js` / `jayson`
tree (`stream-json` and `uuid`). npm proposes a major web3.js migration. That separate
migration was not applied to this approval-flow patch.
