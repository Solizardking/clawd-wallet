// Token name resolution for Clawd Chain holdings (port of clawd-chain extension/names.js).

export type HoldingRow = { mint: string; balance: string; name?: string | null; amount?: string };
export type Holding = { mint: string; name: string | null; balance: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Extract a display name from a getAccountInfo(jsonParsed) mint result. */
export function parseMintAccount(info: unknown): string | null {
  const value = isObj(info) && "value" in info ? info.value : info;
  if (!isObj(value)) return null;
  if (str(value.name)) return str(value.name);
  const data = value.data;
  const parsed = isObj(data) ? data.parsed : undefined;
  const pinfo = isObj(parsed) ? parsed.info : undefined;
  if (!isObj(pinfo)) return null;
  if (str(pinfo.name)) return str(pinfo.name);
  const exts = Array.isArray(pinfo.extensions) ? pinfo.extensions : [];
  for (const ext of exts) {
    const state = isObj(ext) ? ext.state : undefined;
    if (isObj(state) && str(state.name)) return str(state.name);
  }
  return null;
}

export function resolveHoldings(rows: HoldingRow[], namesByMint: Record<string, string | null>): Holding[] {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const mint = row?.mint ? String(row.mint) : "";
    const name = str(namesByMint?.[mint]) || str(row?.name) || null;
    const balance = row?.balance != null ? String(row.balance) : row?.amount != null ? String(row.amount) : "0";
    return { mint, name, balance };
  });
}

/** Rows from getTokenAccountsByOwner(jsonParsed). */
export function accountRows(result: unknown): HoldingRow[] {
  const value = isObj(result) && Array.isArray(result.value) ? result.value : [];
  const rows: HoldingRow[] = [];
  for (const item of value) {
    const info = (item as { account?: { data?: { parsed?: { info?: Obj } } } })?.account?.data?.parsed?.info;
    if (!info || typeof info.mint !== "string") continue;
    const ta = info.tokenAmount as { amount?: unknown } | undefined;
    rows.push({ mint: info.mint, balance: String(ta?.amount ?? "0") });
  }
  return rows;
}
