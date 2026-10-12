/** The legacy backend bridge has no per-request consent UI. Keep it disabled. */
export const LEGACY_COMMAND_ERROR = {
  code: 4200,
  message: "Legacy backend commands are disabled until a secure per-request consent flow is implemented. Use the Solana provider for wallet requests.",
};

export function providerOrigin(sender: chrome.runtime.MessageSender): string {
  if (sender.id !== chrome.runtime.id || sender.tab?.id === undefined || !sender.url) {
    throw { code: 4100, message: "Wallet requests must come from a web page in this extension's content script" };
  }
  const url = new URL(sender.url);
  if (!["https:", "http:"].includes(url.protocol) || (sender.origin !== undefined && sender.origin !== url.origin)) {
    throw { code: 4100, message: "Invalid wallet request origin" };
  }
  return url.origin;
}

export function requirePopupSender(sender: chrome.runtime.MessageSender): void {
  const expected = new URL(chrome.runtime.getURL("popup.html"));
  let actual: URL;
  try {
    actual = new URL(sender.url ?? "");
  } catch {
    throw { code: 4100, message: "Popup commands are restricted to the wallet popup" };
  }
  // Notification windows are extension pages hosted in tabs, so tab presence
  // cannot identify a webpage. Authenticate the extension ID and exact URL.
  const expectedOrigin = `${expected.protocol}//${expected.host}`;
  if (sender.id !== chrome.runtime.id ||
      (sender.origin !== undefined && sender.origin !== expectedOrigin) ||
      actual.protocol !== expected.protocol || actual.host !== expected.host || actual.pathname !== expected.pathname) {
    throw { code: 4100, message: "Popup commands are restricted to the wallet popup" };
  }
}
