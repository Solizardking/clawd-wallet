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

// Relay page -> background for both channels.
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data) return;

  if (data.channel === HELMSMAN_CHANNEL) {
    chrome.runtime.sendMessage(data.msg, (response) => {
      const err = chrome.runtime.lastError;
      window.postMessage(
        {
          channel: HELMSMAN_REPLY_CHANNEL,
          id: data.id,
          // injected.ts resolves `result` / rejects `error` — never `response`
          result: err ? undefined : response?.result ?? response,
          error: err
            ? { message: err.message }
            : response?.error
              ? { message: response.error.message ?? String(response.error) }
              : undefined,
        },
        "*",
      );
    });
    return;
  }

  if (data.channel === SOLANA_REQUEST_CHANNEL) {
    chrome.runtime.sendMessage(
      { type: "solana:request", id: data.id, method: data.method, params: data.params },
      (response) => {
        window.postMessage(
          {
            channel: SOLANA_REPLY_CHANNEL,
            id: data.id,
            result: response?.result,
            error: response?.error,
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
