// Channel names are inlined (kept in sync with src/protocol.ts) so this classic
// content script stays self-contained with no shared Rollup chunk.
const HELMSMAN_CHANNEL = "helmsman";
const HELMSMAN_REPLY_CHANNEL = "helmsman-reply";
const SOLANA_REQUEST_CHANNEL = "helmsman-solana";
const SOLANA_REPLY_CHANNEL = "helmsman-solana-reply";
const SOLANA_EVENT_CHANNEL = "helmsman-solana-event";

// The in-page provider (injected.js) is declared in manifest.json as a
// MAIN-world content script at document_start, so it runs before any page
// script and is not exposed as a web-accessible (probeable) resource.

// Only the Solana provider channel can reach background commands.
window.addEventListener("message", (event) => {
  // Only same-window, same-origin messages (never other frames/windows).
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data) return;

  if (data.channel === HELMSMAN_CHANNEL) {
    window.postMessage({
      channel: HELMSMAN_REPLY_CHANNEL,
      id: data.id,
      error: { code: 4200, message: "Legacy backend commands are disabled until a secure per-request consent flow is implemented. Use the Solana provider for wallet requests." },
    }, window.location.origin);
    return;
  }

  if (data.channel === SOLANA_REQUEST_CHANNEL) {
    chrome.runtime.sendMessage(
      { type: "solana:request", id: String(data.id), method: String(data.method), params: data.params },
      (response) => {
        const err = chrome.runtime.lastError;
        window.postMessage(
          {
            channel: SOLANA_REPLY_CHANNEL,
            id: data.id,
            result: response?.result,
            error: err ? { message: err.message } : response?.error,
          },
          window.location.origin,
        );
      },
    );
    return;
  }
});

// Relay background -> page provider events (stateChanged/accountsChanged/...).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "solana:event") {
    window.postMessage(
      { channel: SOLANA_EVENT_CHANNEL, event: msg.event, data: msg.data },
      window.location.origin,
    );
  }
});
