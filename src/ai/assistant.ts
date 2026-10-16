// Clawd Wallet AI assistant. Requests go to the user's musebook-proxy worker,
// which holds OPENROUTER_API_KEY as a secret and applies OPENROUTER_DEFAULT_MODEL.
// No API key and no model id live in the extension. No wallet secrets are sent.
export const AI_PROXY_URL = "https://musebook-proxy.mynameisjeffspicoli.workers.dev/api/wallet-chat";

export type ChatMessage = { role: "user" | "assistant"; content: string };

const SYSTEM =
  "You are Clawd, the assistant inside the Clawd Wallet browser extension (Solana and Clawd Chain). " +
  "Be concise. Never ask for seed phrases, private keys or passwords. You cannot execute transactions; " +
  "every connection, signature and transfer needs the user's approval in the wallet. CLAWD on Clawd Chain has no monetary value.";

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * True if text contains one of the wallet's secrets (recovery phrase, seed) or
 * something shaped like a raw Solana secret key (64-byte base58 / byte array).
 */
export function containsSecret(text: string, secrets: string[] = []): boolean {
  const t = norm(text);
  for (const s of secrets) if (s && s.length >= 8 && t.includes(norm(s))) return true;
  if (/\b[1-9A-HJ-NP-Za-km-z]{86,90}\b/.test(text)) return true; // base58 64-byte key
  if (/\[\s*(\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/.test(text)) return true; // JSON keypair array
  return false;
}

export async function askAssistant(history: ChatMessage[], secrets: string[] = []): Promise<{ reply: string; model?: string }> {
  if (history.some((m) => typeof m?.content === "string" && containsSecret(m.content, secrets))) {
    throw new Error("Not sent: your message looks like it contains a recovery phrase or private key. Never share it, not even with Clawd.");
  }
  const messages = history
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  if (!messages.some((m) => m.role === "user")) throw new Error("Ask something first");
  const res = await fetch(AI_PROXY_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream: false, messages: [{ role: "system", content: SYSTEM }, ...messages] }),
  });
  const json = (await res.json().catch(() => ({}))) as {
    error?: string | { message?: string };
    model?: string;
    choices?: { message?: { content?: string } }[];
  };
  if (!res.ok) {
    const e = typeof json.error === "string" ? json.error : json.error?.message;
    throw new Error(e ?? `Assistant unavailable (${res.status})`);
  }
  const reply = json.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error("Empty reply");
  return { reply, model: json.model };
}
