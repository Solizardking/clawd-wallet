import type {
  ActivityEntry,
  AutoApproveSession,
  Network,
  PendingActionView,
  PopupMethod,
  PopupState,
  TxPreview,
} from "./protocol.js";
// Type-only import: keeps Clawd runtime code (and its deps) out of a shared chunk.
import type { ClawdOverview, ClawdSignedTransfer } from "./clawd/chain.js";

const CLAWD_CLUSTER = "clawd";
const CLAWD_NOTICE = "CLAWD has no monetary value. Clawd Chain is a public SVM test playground, not Solana mainnet.";

const app = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
const isNotification = params.get("view") === "notification";

function rpc<T = unknown>(method: PopupMethod, rpcParams?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "popup:request", id: crypto.randomUUID(), method, params: rpcParams },
      (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (response?.error) return reject(new Error(response.error.message ?? "Request failed"));
        resolve(response?.result as T);
      },
    );
  });
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string>> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function short(addr: string): string {
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

function clear() {
  app.textContent = "";
}

function showError(message: string) {
  const banner = el("div", { class: "error" }, [message]);
  app.prepend(banner);
  setTimeout(() => banner.remove(), 4000);
}

// ---- Screens ----

// While the one-time recovery phrase is on screen, background state broadcasts
// (createWallet emits stateChanged) must not re-render it away.
let showingBackup = false;

async function render() {
  const state = await rpc<PopupState>("popup_getState");
  // A render started by a stateChanged broadcast can resolve after the backup
  // screen is shown; never let it replace the one-time recovery phrase.
  if (showingBackup) return;
  clear();

  if (isNotification && state.pendingActions.length > 0) {
    return renderApprovals(state);
  }

  switch (state.walletState) {
    case "uninitialized":
      return renderWelcome();
    case "locked":
      return renderUnlock();
    case "unlocked":
      if (state.pendingActions.length > 0) return renderApprovals(state);
      return renderWallet(state);
  }
}

function renderWelcome() {
  app.append(
    el("h1", {}, ["Helmsman"]),
    el("p", { class: "muted" }, ["Solana-native agentic wallet"]),
  );

  const pw = el("input", { type: "password", placeholder: "New password (min 8 chars)" }) as HTMLInputElement;
  const pw2 = el("input", { type: "password", placeholder: "Confirm password" }) as HTMLInputElement;
  const createBtn = el("button", { class: "primary" }, ["Create new wallet"]);
  createBtn.addEventListener("click", async () => {
    if (pw.value !== pw2.value) return showError("Passwords do not match");
    try {
      const { mnemonic } = await rpc<{ mnemonic: string }>("popup_createWallet", {
        password: pw.value,
      });
      renderBackup(mnemonic);
    } catch (e) {
      showError((e as Error).message);
    }
  });

  app.append(
    el("div", { class: "card" }, [
      el("h2", {}, ["Create"]),
      pw,
      pw2,
      createBtn,
    ]),
  );

  const mnem = el("textarea", { placeholder: "Recovery phrase (12 words)", rows: "3" }) as HTMLTextAreaElement;
  const rpw = el("input", { type: "password", placeholder: "Password (min 8 chars)" }) as HTMLInputElement;
  const restoreBtn = el("button", {}, ["Restore wallet"]);
  restoreBtn.addEventListener("click", async () => {
    try {
      await rpc("popup_restoreWallet", { mnemonic: mnem.value, password: rpw.value });
      render();
    } catch (e) {
      showError((e as Error).message);
    }
  });
  app.append(
    el("div", { class: "card" }, [el("h2", {}, ["Restore"]), mnem, rpw, restoreBtn]),
  );
}

function renderBackup(mnemonic: string) {
  showingBackup = true;
  clear();
  app.append(
    el("h1", {}, ["Back up your phrase"]),
    el("p", { class: "muted" }, ["Write these 12 words down. They are the only way to recover your wallet."]),
    el("div", { class: "mnemonic" }, [mnemonic]),
  );
  const done = el("button", { class: "primary" }, ["I saved it — continue"]);
  done.addEventListener("click", () => {
    showingBackup = false;
    void render();
  });
  app.append(done);
}

function renderUnlock() {
  app.append(el("h1", {}, ["Unlock"]), el("p", { class: "muted" }, ["Enter your password"]));
  const pw = el("input", { type: "password", placeholder: "Password" }) as HTMLInputElement;
  const btn = el("button", { class: "primary" }, ["Unlock"]);
  const submit = async () => {
    try {
      await rpc("popup_unlockWallet", { password: pw.value });
      render();
    } catch (e) {
      showError((e as Error).message);
    }
  };
  btn.addEventListener("click", submit);
  pw.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  app.append(el("div", { class: "card" }, [pw, btn]));
}

async function renderWallet(state: PopupState) {
  const header = el("div", { class: "row spread" }, [
    el("h1", {}, ["Helmsman"]),
    (() => {
      const lock = el("button", { class: "ghost" }, ["Lock"]);
      lock.addEventListener("click", async () => {
        await rpc("popup_lockWallet");
        render();
      });
      return lock;
    })(),
  ]);
  app.append(header);

  // Network selector
  const select = el("select", {}) as HTMLSelectElement;
  for (const n of state.availableNetworks) {
    const opt = el("option", { value: n.cluster }, [n.title]) as HTMLOptionElement;
    if (n.cluster === state.selectedNetwork.cluster) opt.selected = true;
    select.append(opt);
  }
  select.addEventListener("change", async () => {
    await rpc("popup_changeNetwork", { cluster: select.value });
    render();
  });
  app.append(el("div", { class: "row spread" }, [el("span", { class: "muted" }, ["Network"]), select]));

  app.append(el("div", { class: "banner" }, ["Connections, signing and transfers require your approval."]));

  // Accounts
  const list = el("div", { class: "card" }, [el("h2", {}, ["Accounts"])]);
  for (const address of state.accounts) {
    const isSelected = address === state.selectedAccount;
    const row = el("div", { class: `acct ${isSelected ? "selected" : ""}` });
    const label = el("code", { title: address }, [short(address)]);
    const bal = el("span", { class: "muted bal" }, ["…"]);
    const unit = state.selectedNetwork.cluster === CLAWD_CLUSTER ? "CLAWD" : "SOL";
    void rpc<{ sol: number }>("popup_getBalance", { address })
      .then((b) => (bal.textContent = `${b.sol.toFixed(4)} ${unit}`))
      .catch(() => (bal.textContent = "—"));
    const copy = el("button", { class: "ghost sm" }, ["Copy"]);
    copy.addEventListener("click", () => navigator.clipboard.writeText(address));
    row.append(label, bal, copy);
    if (!isSelected) {
      const use = el("button", { class: "ghost sm" }, ["Use"]);
      use.addEventListener("click", async () => {
        await rpc("popup_selectAccount", { address });
        render();
      });
      row.append(use);
    }
    list.append(row);
  }
  const add = el("button", { class: "ghost" }, ["+ Add account"]);
  add.addEventListener("click", async () => {
    await rpc("popup_addAccount");
    render();
  });
  list.append(add);
  app.append(list);

  if (state.selectedNetwork.cluster === CLAWD_CLUSTER) app.append(renderClawd(state));

  app.append(renderAssistant());

  // Send SOL
  const to = el("input", { placeholder: "Recipient address" }) as HTMLInputElement;
  const amt = el("input", { type: "number", step: "0.0001", placeholder: "Amount (SOL)" }) as HTMLInputElement;
  const send = el("button", { class: "primary" }, ["Send SOL"]);
  send.addEventListener("click", async () => {
    try {
      const { signature } = await rpc<{ signature: string }>("popup_sendSol", {
        to: to.value,
        sol: Number(amt.value),
      });
      showError(`Sent: ${short(signature)}`);
    } catch (e) {
      showError((e as Error).message);
    }
  });
  app.append(el("div", { class: "card" }, [el("h2", {}, ["Send"]), to, amt, send]));

  // Connected sites + auto-approve sessions + per-site activity
  if (state.authorizedOrigins.length) app.append(renderSitePanel(state));

  const lockSel = el("select", { "aria-label": "Auto-lock" }, [5, 15, 30, 60, 240].map((m) =>
    el("option", { value: String(m), ...(m === state.autoLockMinutes ? { selected: "selected" } : {}) }, [`${m} min`]))) as HTMLSelectElement;
  lockSel.addEventListener("change", async () => { await rpc("popup_setAutoLock", { minutes: Number(lockSel.value) }); showError("Auto-lock updated"); });
  app.append(el("div", { class: "card" }, [el("h2", {}, ["Auto-lock"]), el("p", { class: "muted" }, ["Lock after inactivity. Locking ends every auto-approve session."]), lockSel]));

  const api = el("input", {
    type: "url",
    placeholder: "https://musebook.trade/wallet",
    value: state.helmsmanApiUrl,
  }) as HTMLInputElement;
  const saveApi = el("button", { class: "ghost" }, ["Save API"]);
  saveApi.addEventListener("click", async () => {
    try {
      await rpc("popup_setHelmsmanApi", { apiUrl: api.value });
      showError("Helmsman API saved");
    } catch (e) {
      showError((e as Error).message);
    }
  });
  app.append(
    el("div", { class: "card" }, [
      el("h2", {}, ["Helmsman API"]),
      el("p", { class: "muted" }, ["Control plane this extension talks to (the site you downloaded it from)."]),
      api,
      saveApi,
    ]),
  );

  const rpcInput = el("input", {
    type: "url",
    placeholder: "https://mainnet.helius-rpc.com/?api-key=…",
    value: state.customRpcUrl || "",
  }) as HTMLInputElement;
  const saveRpc = el("button", { class: "primary" }, ["Save & use Custom RPC"]);
  saveRpc.addEventListener("click", async () => {
    try {
      await rpc("popup_setCustomRpc", { rpcUrl: rpcInput.value, select: true });
      showError("Custom RPC saved — Network set to Custom RPC");
      render();
    } catch (e) {
      showError((e as Error).message);
    }
  });
  app.append(
    el("div", { class: "card" }, [
      el("h2", {}, ["Solana RPC"]),
      el("p", { class: "muted" }, [
        "Your own HTTPS JSON-RPC (Helius, QuickNode, Triton, self-hosted). Stored only in this extension.",
      ]),
      rpcInput,
      saveRpc,
    ]),
  );
}

const KNOWN_SAFE_LIST = [
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
];
const TX_TYPES = new Set(["sign_transaction", "sign_b64", "sign_and_send", "sign_all"]);
const sol = (lamports: number) => `${(lamports / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 })} SOL`;

function kv(k: string, v: string): HTMLElement {
  return el("div", { class: "kv" }, [el("span", { class: "muted" }, [k]), el("span", {}, [v])]);
}

function renderPreview(p: TxPreview, label?: string): HTMLElement {
  const card = el("div", { class: "card", "data-testid": "tx-preview" });
  if (label) card.append(el("h2", {}, [label]));
  for (const w of p.warnings) card.append(el("div", { class: `warn w-${w.level}`, "data-code": w.code }, [w.message]));
  if (!p.simulation.ok) {
    card.append(el("p", { class: "muted" }, ["Could not simulate: estimated changes unavailable. Check the raw details below before approving."]));
  }
  const changes = el("div", {}, [el("h2", {}, ["Estimated balance changes"])]);
  if (p.simulation.ok && !p.balanceChanges.length) changes.append(el("p", { class: "muted" }, ["No balance changes for your accounts (besides the fee)."]));
  for (const c of p.balanceChanges) {
    const neg = c.uiDelta.startsWith("-");
    changes.append(el("div", { class: "delta" }, [
      el("span", { title: c.mint ?? "SOL" }, [c.symbol]),
      el("span", { class: neg ? "neg" : "pos" }, [c.uiDelta]),
    ]));
  }
  if (p.simulation.ok) card.append(changes);
  card.append(
    kv("Network fee", sol(p.baseFeeLamports)),
    kv("Priority fee", `${sol(p.priorityFeeLamports)} (${p.computeUnitPriceMicroLamports} µL/CU × ${p.computeUnitLimit.toLocaleString()} CU)`),
    kv("Total fee", sol(p.feeLamports)),
    kv("Max SOL leaving wallet", sol(p.solOutflowLamports)),
    kv("Version", String(p.version)),
  );
  if (p.simulation.unitsConsumed) card.append(kv("Simulated compute", p.simulation.unitsConsumed.toLocaleString() + " CU"));
  const progs = el("div", {}, [el("h2", {}, ["Programs"])]);
  for (const pr of p.programs) {
    progs.append(el("div", { class: "prog" }, [
      el("span", { class: pr.name ? "" : "unknown" }, [pr.name ?? "Unknown program"]),
      " ",
      el("code", { title: pr.id }, [short(pr.id)]),
    ]));
  }
  card.append(progs);
  const wr = el("details", {}, [el("summary", {}, [`Writable accounts (${p.writable.length})`]), el("pre", {}, [p.writable.join("\n")])]);
  const raw = el("details", {}, [el("summary", {}, [`Raw instructions (${p.instructions.length})`])]);
  raw.append(el("pre", {}, [p.instructions.map((ix) =>
    `#${ix.index + 1} ${ix.programName ?? "Unknown"} ${ix.programId}\n` +
    (ix.summary ? `  ${ix.summary}\n` : "") +
    ix.accounts.map((a) => `  ${a.signer ? "S" : "-"}${a.writable ? "W" : "-"} ${a.address}`).join("\n") +
    `\n  data: ${ix.dataHex || "(empty)"}`).join("\n\n")]));
  card.append(wr, raw);
  if (p.simulation.logs?.length || p.simulation.error) {
    card.append(el("details", {}, [el("summary", {}, ["Simulation logs"]), el("pre", {}, [[p.simulation.error ?? "", ...(p.simulation.logs ?? [])].filter(Boolean).join("\n")])]));
  }
  return card;
}

function autoApproveForm(defaultPrograms: string[], onSubmit: (req: { durationMs: number; maxTotalSol: number; maxPerTxSol: number; allowedPrograms: string[] }) => void, submitLabel?: string): HTMLElement {
  const box = el("div", { class: "autoform" });
  const expiry = el("select", {}, [
    el("option", { value: String(15 * 60_000) }, ["15 minutes"]),
    el("option", { value: String(3600_000) }, ["1 hour"]),
    el("option", { value: String(24 * 3600_000) }, ["24 hours"]),
    el("option", { value: "custom" }, ["Custom (minutes)"]),
  ]) as HTMLSelectElement;
  const custom = el("input", { type: "number", min: "1", max: "10080", placeholder: "minutes", style: "display:none" }) as HTMLInputElement;
  expiry.addEventListener("change", () => { custom.style.display = expiry.value === "custom" ? "" : "none"; });
  const total = el("input", { type: "number", min: "0", step: "0.01", value: "0.1", "aria-label": "Max total SOL" }) as HTMLInputElement;
  const perTx = el("input", { type: "number", min: "0", step: "0.01", value: "0.02", "aria-label": "Max SOL per transaction" }) as HTMLInputElement;
  const programs = el("textarea", { rows: "3", "aria-label": "Allowed program IDs" }) as HTMLTextAreaElement;
  programs.value = defaultPrograms.join("\n");
  box.append(
    el("label", {}, ["Expires after", expiry, custom]),
    el("label", {}, ["Max total SOL outflow", total]),
    el("label", {}, ["Max SOL per transaction", perTx]),
    el("label", {}, ["Allowed program IDs (one per line)", programs]),
    el("p", { class: "muted" }, ["Transactions are still simulated. Anything with errors, authority/owner changes, closes to other owners, token approvals or delegations, other programs, or over the limits asks you as usual. Locking the wallet ends the session."]),
  );
  if (submitLabel) {
    const go = el("button", { class: "primary" }, [submitLabel]);
    go.addEventListener("click", () => onSubmit(read()));
    box.append(go);
  }
  function read() {
    const minutes = expiry.value === "custom" ? Number(custom.value) : Number(expiry.value) / 60_000;
    return {
      durationMs: minutes * 60_000,
      maxTotalSol: Number(total.value),
      maxPerTxSol: Number(perTx.value),
      allowedPrograms: programs.value.split(/\s+/).filter(Boolean),
    };
  }
  (box as HTMLElement & { read?: typeof read }).read = read;
  return box;
}

function renderApprovals(state: PopupState) {
  document.body.classList.add("wide");
  const action = state.pendingActions[0];
  const titles: Record<PendingActionView["type"], string> = {
    request_accounts: "Connection request",
    sign_transaction: "Approve transaction",
    sign_message: "Sign message",
    sign_and_send: "Approve & send transaction",
    sign_b64: "Approve transaction",
    sign_all: "Approve transactions",
    sign_in: "Sign in request",
    send_sol: "Approve SOL transfer",
  };
  const queue = state.pendingActions.length > 1 ? ` (1 of ${state.pendingActions.length})` : "";
  app.append(el("h1", {}, [titles[action.type] + queue]), el("p", { class: "muted" }, [action.origin]));
  if (action.autoApproveNote) app.append(el("div", { class: "warn w-info" }, [action.autoApproveNote]));

  const details = el("div", { class: "card" });
  let autoBox: (HTMLElement & { read?: () => { durationMs: number; maxTotalSol: number; maxPerTxSol: number; allowedPrograms: string[] } }) | null = null;
  let autoToggle: HTMLInputElement | null = null;
  if (action.type === "request_accounts") {
    details.append(el("p", {}, ["This site wants to view your wallet accounts:"]));
    for (const a of state.accounts) details.append(el("code", { class: "block" }, [a]));
  } else if (action.type === "sign_message") {
    if (action.messageLooksLikeTransaction) details.append(el("div", { class: "warn w-danger" }, ["These bytes look like a Solana transaction. Signing them could authorize a transaction. Only continue if you trust this site."]));
    details.append(
      el("p", {}, [action.messageIsUtf8 === false ? "Message (binary, shown as hex):" : "Message:"]),
      el("div", { class: action.messageIsUtf8 === false ? "mnemonic small" : "mnemonic" }, [action.message ?? ""]),
      el("p", { class: "muted" }, [`Signer: ${(action.signers ?? []).map(short).join(", ")}`]),
    );
  } else if (action.type === "sign_in") {
    for (const w of action.signIn?.warnings ?? []) details.append(el("div", { class: "warn w-warn" }, [w]));
    details.append(
      el("p", {}, ["This site asks you to sign in. Domain verified against the requesting page."]),
      el("div", { class: "mnemonic small", style: "white-space:pre-wrap;font-size:11px;max-height:200px" }, [action.signIn?.text ?? ""]),
    );
  } else if (action.type === "send_sol") {
    details.append(
      el("p", {}, [`Send ${action.amountSol ?? 0} SOL to:`]),
      el("code", { class: "block" }, [action.to ?? ""]),
    );
  } else {
    const n = action.type === "sign_all" ? action.transactions?.length ?? 0 : 1;
    details.append(el("p", {}, [
      action.type === "sign_and_send"
        ? "This site wants the wallet to sign and broadcast a transaction."
        : n > 1 ? `This site wants the wallet to sign ${n} transactions (not broadcast).` : "This site wants the wallet to sign a transaction (not broadcast).",
    ]));
    if (action.sendOptions && Object.keys(action.sendOptions).length) {
      details.append(el("p", { class: "muted" }, [`Send options: ${JSON.stringify(action.sendOptions)}`]));
    }
  }
  app.append(details);

  if (TX_TYPES.has(action.type)) {
    if (!action.previews) {
      app.append(el("div", { class: "card", "data-testid": "simulating" }, ["Simulating transaction…"]));
    } else {
      const total = action.previews.length;
      action.previews.forEach((p, i) => app.append(renderPreview(p, total > 1 ? `Transaction ${i + 1} of ${total}` : undefined)));
      const blocked = action.previews.some((p) => p.blocking.length || !p.simulation.ok);
      if (!blocked) {
        const progs = [...new Set(action.previews.flatMap((p) => p.programs.map((x) => x.id)))].filter((id) => id !== "ComputeBudget111111111111111111111111111111");
        autoToggle = el("input", { type: "checkbox", id: "auto-toggle" }) as HTMLInputElement;
        autoBox = autoApproveForm(progs, () => {});
        autoBox.style.display = "none";
        autoToggle.addEventListener("change", () => { autoBox!.style.display = autoToggle!.checked ? "" : "none"; });
        app.append(el("div", { class: "card" }, [
          el("label", { for: "auto-toggle", class: "row" }, [autoToggle, `Auto-approve similar requests from ${action.origin}`]),
          autoBox,
        ]));
      }
    }
  }

  const approve = el("button", { class: "primary" }, ["Approve"]);
  approve.addEventListener("click", async () => {
    try {
      await rpc("popup_approveAction", { id: action.id, autoApprove: autoToggle?.checked && autoBox?.read ? autoBox.read() : undefined });
    } catch (e) {
      return showError((e as Error).message);
    }
    const next = await rpc<PopupState>("popup_getState");
    if (isNotification && next.pendingActions.length === 0) window.close();
    else render();
  });
  const decline = el("button", { class: "ghost" }, ["Reject"]);
  decline.addEventListener("click", async () => {
    await rpc("popup_declineAction", { id: action.id });
    const next = await rpc<PopupState>("popup_getState");
    if (isNotification && next.pendingActions.length === 0) window.close();
    else render();
  });
  app.append(el("div", { class: "row" }, [approve, decline]));
}

function renderSitePanel(state: PopupState): HTMLElement {
  const auth = el("div", { class: "card" }, [el("h2", {}, ["Connected sites"])]);
  const sessions = new Map<string, AutoApproveSession>(state.autoApprove.map((s) => [s.origin, s]));
  for (const origin of state.authorizedOrigins) {
    const sess = sessions.get(origin);
    const row = el("div", { class: "row spread" }, [el("code", {}, [origin])]);
    if (sess) row.append(el("span", { class: "pill auto" }, [`auto · ${Math.max(0, Math.round((sess.expiresAt - Date.now()) / 60_000))}m`]));
    const del = el("button", { class: "ghost sm" }, ["Revoke"]);
    del.addEventListener("click", async () => {
      await rpc("popup_deleteAuthorizedOrigin", { origin });
      render();
    });
    row.append(del);
    auth.append(row);
    if (sess) {
      auth.append(el("p", { class: "muted" }, [`Auto-approve: ${sol(sess.spentLamports)} of ${sol(sess.maxTotalLamports)} used, ≤ ${sol(sess.maxPerTxLamports)}/tx, ${sess.count} auto-approved, ${sess.allowedPrograms.length} programs.`]));
      const stop = el("button", { class: "ghost sm" }, ["Stop auto-approve"]);
      stop.addEventListener("click", async () => { await rpc("popup_revokeAutoApprove", { origin }); render(); });
      auth.append(stop);
    } else {
      const details = el("details", {}, [el("summary", {}, ["Auto-approve…"])]);
      details.append(autoApproveForm(KNOWN_SAFE_LIST, async (req) => {
        try { await rpc("popup_setAutoApprove", { origin, ...req }); render(); } catch (e) { showError((e as Error).message); }
      }, "Enable auto-approve"));
      auth.append(details);
    }
    const acts = state.activity.filter((a) => a.origin === origin).slice(0, 8);
    if (acts.length) {
      const list = el("details", {}, [el("summary", {}, [`Activity (${acts.length})`])]);
      for (const a of acts) list.append(activityRow(a));
      auth.append(list);
    }
  }
  return auth;
}

function activityRow(a: ActivityEntry): HTMLElement {
  return el("div", { class: "activity" }, [
    `${new Date(a.at).toLocaleTimeString()} · ${a.type} · ${a.result}`,
    a.auto ? el("span", { class: "pill auto" }, ["auto"]) : "",
    a.outflowLamports ? ` · ${sol(a.outflowLamports)}` : "",
    a.signature ? el("code", { title: a.signature }, [" " + short(a.signature)]) : "",
  ]);
}

render().catch((e) => showError((e as Error).message));

// Keep the notification popup fresh if new actions arrive.
chrome.runtime.onMessage?.addListener((msg) => {
  if (msg?.type === "clawd:refresh" && !showingBackup) render();
  if (msg?.type === "solana:event" && msg.event === "stateChanged" && !showingBackup) render();
});

export type { Network };

// ---- Clawd Chain panel (ported from clawd-chain extension popup) ----
function renderClawd(state: PopupState): HTMLElement {
  const card = el("div", { class: "card" }, [el("h2", {}, ["Clawd Chain"])]);
  card.append(el("div", { class: "banner" }, [CLAWD_NOTICE]));
  const shield = el("p", { class: "muted" }, [""]);
  card.append(shield);
  const balance = el("div", {}, ["Balance: …"]);
  const addr = el("a", { target: "_blank", rel: "noopener" }, [state.selectedAccount ?? ""]) as HTMLAnchorElement;
  const holdings = el("pre", { class: "muted" }, [""]);
  card.append(balance, el("code", { class: "block" }, [addr]), holdings);
  const refresh = () =>
    rpc<ClawdOverview>("popup_clawdOverview")
      .then((o) => {
        balance.textContent = `Balance: ${o.clawd} CLAWD`;
        shield.textContent = o.shieldReset;
        addr.href = o.explorerUrl;
        addr.textContent = o.address;
        holdings.textContent = o.holdings.length
          ? o.holdings.map((h) => `${h.name || "Unnamed"} · ${h.balance}`).join("\n")
          : "No tokens yet";
      })
      .catch((e) => (balance.textContent = `Balance: ${(e as Error).message}`));
  void refresh();

  const status = el("div", { class: "muted" }, [""]);
  const pinch = el("button", { class: "primary" }, ["Get CLAWD (faucet)"]) as HTMLButtonElement;
  pinch.addEventListener("click", async () => {
    pinch.disabled = true;
    status.textContent = "Mining proof of work…";
    try {
      const drop = await rpc<{ amount?: unknown }>("popup_clawdFaucet");
      status.textContent = drop.amount != null ? `+${String(drop.amount)} CLAWD` : "Airdrop sent";
      await refresh();
    } catch (e) {
      status.textContent = (e as Error).message;
    } finally {
      pinch.disabled = false;
    }
  });
  card.append(el("p", { class: "muted" }, ["Faucet: proof of work solved in your browser, 5 CLAWD per wallet per day."]), pinch, status);

  const to = el("input", { placeholder: "Recipient address" }) as HTMLInputElement;
  const amt = el("input", { type: "number", step: "0.000000001", placeholder: "Amount (CLAWD)" }) as HTMLInputElement;
  const sign = el("button", { class: "ghost" }, ["Sign (offline, not broadcast)"]);
  const signed = el("code", { class: "block" }, [""]);
  sign.addEventListener("click", async () => {
    try {
      const s = await rpc<ClawdSignedTransfer>("popup_clawdSign", { recipient: to.value, amount: amt.value });
      signed.textContent = `${s.sender} → ${s.recipient} · ${s.amount} CLAWD\nsig ${s.signature}`;
    } catch (e) {
      signed.textContent = (e as Error).message;
    }
  });
  card.append(el("h2", {}, ["Sign transfer intent"]), to, amt, sign, signed);
  return card;
}

// ---- AI assistant (OpenRouter via the musebook-proxy worker; no key in the extension) ----
const chatHistory: { role: "user" | "assistant"; content: string }[] = [];
function renderAssistant(): HTMLElement {
  const log = el("pre", { class: "muted" }, [""]);
  const paint = () =>
    (log.textContent = chatHistory.map((m) => `${m.role === "user" ? "You" : "Clawd"}: ${m.content}`).join("\n\n"));
  paint();
  const input = el("input", { placeholder: "Ask Clawd…" }) as HTMLInputElement;
  const ask = el("button", { class: "ghost" }, ["Ask"]) as HTMLButtonElement;
  ask.addEventListener("click", async () => {
    const q = input.value.trim();
    if (!q) return;
    chatHistory.push({ role: "user", content: q });
    input.value = "";
    ask.disabled = true;
    paint();
    try {
      const { reply } = await rpc<{ reply: string }>("popup_aiChat", { messages: chatHistory });
      chatHistory.push({ role: "assistant", content: reply });
    } catch (e) {
      chatHistory.pop();
      showError((e as Error).message);
    } finally {
      ask.disabled = false;
      paint();
    }
  });
  return el("div", { class: "card" }, [
    el("h2", {}, ["Assistant"]),
    el("p", { class: "muted" }, ["AI help. Never share your recovery phrase. It cannot sign or send anything."]),
    log,
    input,
    ask,
  ]);
}
