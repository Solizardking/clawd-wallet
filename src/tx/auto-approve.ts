// Per-origin auto-approve sessions ("session keys"-style limits). Original Clawd code.
// Off by default. Never a global switch. Sessions live in chrome.storage.session
// (gone when the browser closes) and are cleared on lock/auto-lock.
import { COMPUTE_BUDGET } from "./programs.js";
import type { TxPreview } from "./preview.js";

export type AutoApproveSession = {
  origin: string;
  createdAt: number;
  expiresAt: number;
  maxTotalLamports: number;
  maxPerTxLamports: number;
  allowedPrograms: string[];
  spentLamports: number;
  count: number;
};

export type AutoApproveRequest = {
  durationMs: number;
  maxTotalSol: number;
  maxPerTxSol: number;
  allowedPrograms: string[];
};

export const MAX_DURATION_MS = 7 * 24 * 3600_000;
const PROGRAM_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function createSession(origin: string, req: AutoApproveRequest, now = Date.now()): AutoApproveSession {
  const durationMs = Number(req.durationMs);
  const maxTotalSol = Number(req.maxTotalSol);
  const maxPerTxSol = Number(req.maxPerTxSol);
  if (!(durationMs > 0) || durationMs > MAX_DURATION_MS) throw new Error("Expiry must be between 1 minute and 7 days");
  if (!(maxTotalSol >= 0) || !(maxPerTxSol >= 0) || !Number.isFinite(maxTotalSol) || !Number.isFinite(maxPerTxSol)) throw new Error("SOL limits must be non-negative numbers");
  if (maxPerTxSol > maxTotalSol) throw new Error("Per-transaction limit cannot exceed the total limit");
  const allowedPrograms = [...new Set((req.allowedPrograms ?? []).map((p) => String(p).trim()).filter(Boolean))];
  if (!allowedPrograms.length) throw new Error("Choose at least one allowed program");
  for (const p of allowedPrograms) if (!PROGRAM_RE.test(p)) throw new Error(`Invalid program id: ${p}`);
  return {
    origin, createdAt: now, expiresAt: now + Math.max(60_000, durationMs),
    maxTotalLamports: Math.round(maxTotalSol * 1e9), maxPerTxLamports: Math.round(maxPerTxSol * 1e9),
    allowedPrograms, spentLamports: 0, count: 0,
  };
}

export type Eligibility = { ok: true; outflowLamports: number } | { ok: false; reason: string };

/** Decide whether a batch of previewed transactions may be auto-approved. */
export function checkAutoApprove(session: AutoApproveSession | undefined, previews: TxPreview[], now = Date.now()): Eligibility {
  if (!session) return { ok: false, reason: "no session" };
  if (now >= session.expiresAt) return { ok: false, reason: "session expired" };
  if (!previews.length) return { ok: false, reason: "nothing to sign" };
  let total = 0;
  for (const p of previews) {
    if (!p.simulation.ok) return { ok: false, reason: "simulation did not succeed" };
    if (p.blocking.length) return { ok: false, reason: `needs manual review: ${p.blocking.join(", ")}` };
    const allowed = new Set([...session.allowedPrograms, COMPUTE_BUDGET]);
    const bad = p.programs.find((pr) => !allowed.has(pr.id));
    if (bad) return { ok: false, reason: `program not allowed: ${bad.id}` };
    if (p.solOutflowLamports > session.maxPerTxLamports) return { ok: false, reason: "per-transaction SOL limit exceeded" };
    total += p.solOutflowLamports;
  }
  if (session.spentLamports + total > session.maxTotalLamports) return { ok: false, reason: "total SOL limit exceeded" };
  return { ok: true, outflowLamports: total };
}

export type ActivityEntry = {
  at: number; origin: string; type: string; auto: boolean; outflowLamports: number;
  programs: string[]; result: "approved" | "rejected" | "failed"; signature?: string; note?: string;
};
