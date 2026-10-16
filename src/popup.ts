import type {
  Network,
  PendingActionView,
  PopupMethod,
  PopupState,
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

  // Authorized origins
  if (state.authorizedOrigins.length) {
    const auth = el("div", { class: "card" }, [el("h2", {}, ["Connected sites"])]);
    for (const origin of state.authorizedOrigins) {
      const row = el("div", { class: "row spread" }, [el("code", {}, [origin])]);
      const del = el("button", { class: "ghost sm" }, ["Revoke"]);
      del.addEventListener("click", async () => {
        await rpc("popup_deleteAuthorizedOrigin", { origin });
        render();
      });
      row.append(del);
      auth.append(row);
    }
    app.append(auth);
  }

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

function renderApprovals(state: PopupState) {
  const action = state.pendingActions[0];
  const titles: Record<PendingActionView["type"], string> = {
    request_accounts: "Connection request",
    sign_transaction: "Approve transaction",
    sign_message: "Sign message",
    sign_and_send: "Approve & send transaction",
    sign_b64: "Sign swap transaction",
    send_sol: "Approve SOL transfer",
  };
  app.append(el("h1", {}, [titles[action.type]]), el("p", { class: "muted" }, [action.origin]));

  const details = el("div", { class: "card" });
  if (action.type === "request_accounts") {
    details.append(el("p", {}, ["This site wants to view your wallet accounts:"]));
    for (const a of state.accounts) details.append(el("code", { class: "block" }, [a]));
  } else if (action.type === "sign_message") {
    details.append(el("p", {}, ["Message:"]), el("div", { class: "mnemonic" }, [action.message ?? ""]));
  } else if (action.type === "send_sol") {
    details.append(
      el("p", {}, [`Send ${action.amountSol ?? 0} SOL to:`]),
      el("code", { class: "block" }, [action.to ?? ""]),
    );
  } else if (action.type === "sign_and_send" || action.type === "sign_b64") {
    details.append(
      el("p", {}, [
        action.type === "sign_b64"
          ? "This site wants the wallet to sign a swap transaction."
          : "This site wants the wallet to sign and broadcast a transaction.",
      ]),
      el("div", { class: "mnemonic small" }, [action.transaction ?? ""]),
    );
  } else {
    details.append(
      el("p", {}, ["Transaction message (base58):"]),
      el("div", { class: "mnemonic small" }, [action.message ?? ""]),
      el("p", { class: "muted" }, [`Signers: ${(action.signers ?? []).map(short).join(", ")}`]),
    );
  }
  app.append(details);

  const approve = el("button", { class: "primary" }, ["Approve"]);
  approve.addEventListener("click", async () => {
    await rpc("popup_approveAction", { id: action.id });
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

render().catch((e) => showError((e as Error).message));

// Keep the notification popup fresh if new actions arrive.
chrome.runtime.onMessage?.addListener((msg) => {
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
