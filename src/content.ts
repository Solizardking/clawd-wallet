// Channel names are inlined (kept in sync with src/protocol.ts) so this classic
// content script stays self-contained with no shared Rollup chunk.
const HELMSMAN_CHANNEL = "helmsman";
const HELMSMAN_REPLY_CHANNEL = "helmsman-reply";
const SOLANA_REQUEST_CHANNEL = "helmsman-solana";
const SOLANA_REPLY_CHANNEL = "helmsman-solana-reply";
const SOLANA_EVENT_CHANNEL = "helmsman-solana-event";

// Inject the in-page provider script into the page context.
const script = document.createElement("script");
script.src = chrome.runtime.getURL("injected.js");
script.type = "module";
(document.head || document.documentElement).appendChild(script);

// Only the Solana provider channel can reach background commands.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data) return;

  if (data.channel === HELMSMAN_CHANNEL) {
    window.postMessage({
      channel: HELMSMAN_REPLY_CHANNEL,
      id: data.id,
      error: { code: 4200, message: "Legacy backend commands are disabled until a secure per-request consent flow is implemented. Use the Solana provider for wallet requests." },
    }, "*");
    return;
  }

  if (data.channel === SOLANA_REQUEST_CHANNEL) {
    chrome.runtime.sendMessage(
      { type: "solana:request", id: data.id, method: data.method, params: data.params },
      (response) => {
        const err = chrome.runtime.lastError;
        window.postMessage(
          {
            channel: SOLANA_REPLY_CHANNEL,
            id: data.id,
            result: response?.result,
            error: err ? { message: err.message } : response?.error,
          },
          "*",
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
      "*",
    );
  }
});
