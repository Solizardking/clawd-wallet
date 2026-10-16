// Sign-In With Solana (SIWS) message construction + origin checks. Original Clawd code.

export type SignInInput = {
  domain?: string; address?: string; statement?: string; uri?: string; version?: string;
  chainId?: string; nonce?: string; issuedAt?: string; expirationTime?: string;
  notBefore?: string; requestId?: string; resources?: string[];
};

const ok = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function buildSignInMessage(input: SignInInput & { domain: string; address: string }): string {
  let m = `${input.domain} wants you to sign in with your Solana account:\n${input.address}`;
  if (ok(input.statement)) m += `\n\n${input.statement}`;
  const f: string[] = [];
  if (ok(input.uri)) f.push(`URI: ${input.uri}`);
  if (ok(input.version)) f.push(`Version: ${input.version}`);
  if (ok(input.chainId)) f.push(`Chain ID: ${input.chainId}`);
  if (ok(input.nonce)) f.push(`Nonce: ${input.nonce}`);
  if (ok(input.issuedAt)) f.push(`Issued At: ${input.issuedAt}`);
  if (ok(input.expirationTime)) f.push(`Expiration Time: ${input.expirationTime}`);
  if (ok(input.notBefore)) f.push(`Not Before: ${input.notBefore}`);
  if (ok(input.requestId)) f.push(`Request ID: ${input.requestId}`);
  if (Array.isArray(input.resources) && input.resources.length) f.push(`Resources:${input.resources.map((r) => `\n- ${r}`).join("")}`);
  if (f.length) m += `\n\n${f.join("\n")}`;
  return m;
}

const CHAINS = new Set(["mainnet", "devnet", "testnet", "localnet", "solana:mainnet", "solana:devnet", "solana:testnet", "solana:localnet"]);

/**
 * Validate a dApp's sign-in request against the page that asked for it.
 * Throws on a domain mismatch (phishing relay); returns warnings otherwise.
 */
export function checkSignIn(input: SignInInput, origin: string, accounts: string[], now = Date.now()): { domain: string; address: string; warnings: string[] } {
  const host = new URL(origin).host;
  const warnings: string[] = [];
  for (const k of ["domain", "address", "statement", "uri", "version", "chainId", "nonce", "issuedAt", "expirationTime", "notBefore", "requestId"] as const) {
    const v = input[k];
    if (v !== undefined && typeof v !== "string") throw { code: -32602, message: `signIn ${k} must be a string` };
    if (typeof v === "string" && /[\r\n]/.test(v) && k !== "statement") throw { code: -32602, message: `signIn ${k} must be a single line` };
  }
  if (typeof input.statement === "string" && /\n/.test(input.statement)) throw { code: -32602, message: "signIn statement must not contain newlines" };
  if (input.resources !== undefined && (!Array.isArray(input.resources) || input.resources.some((r) => typeof r !== "string" || /[\r\n]/.test(r)))) {
    throw { code: -32602, message: "signIn resources must be single-line strings" };
  }
  const domain = input.domain || host;
  if (domain !== host) {
    throw { code: 4100, message: `Sign-in domain mismatch: request says "${domain}" but comes from "${host}". Rejected to prevent phishing.` };
  }
  if (input.uri) {
    let u: URL | null = null;
    try { u = new URL(input.uri); } catch { warnings.push(`URI "${input.uri}" is not a valid URL.`); }
    if (u && u.host !== host) warnings.push(`URI host ${u.host} differs from the requesting site ${host}.`);
  }
  if (input.chainId && !CHAINS.has(input.chainId)) warnings.push(`Unknown chain id "${input.chainId}".`);
  if (input.version && input.version !== "1") warnings.push(`Unexpected SIWS version "${input.version}".`);
  const t = (s?: string) => (s ? Date.parse(s) : NaN);
  if (input.expirationTime && !(t(input.expirationTime) > now)) warnings.push("This sign-in request has already expired.");
  if (input.notBefore && t(input.notBefore) > now) warnings.push("This sign-in request is not valid yet (Not Before is in the future).");
  if (input.issuedAt && Math.abs(t(input.issuedAt) - now) > 10 * 60_000) warnings.push("Issued At is more than 10 minutes from now.");
  const address = input.address || accounts[0];
  if (!address || !accounts.includes(address)) throw { code: 4100, message: "Requested sign-in address is not in this wallet" };
  return { domain, address, warnings };
}
