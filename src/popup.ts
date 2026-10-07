import type {
  Network,
  PendingActionView,
  PopupMethod,
  PopupState,
} from "./protocol.js";

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

async function render() {
  const state = await rpc<PopupState>("popup_getState");
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
  clear();
  app.append(
    el("h1", {}, ["Back up your phrase"]),
    el("p", { class: "muted" }, ["Write these 12 words down. They are the only way to recover your wallet."]),
    el("div", { class: "mnemonic" }, [mnemonic]),
  );
  const done = el("button", { class: "primary" }, ["I saved it — continue"]);
  done.addEventListener("click", () => render());
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

  // Computer-use / Agent mode toggle
  const agentBtn = el("button", { class: state.agentMode ? "primary" : "ghost" }, [
    state.agentMode ? "Computer-use: ON" : "Computer-use: OFF",
  ]);
  agentBtn.addEventListener("click", async () => {
    await rpc("popup_setAgentMode", { enabled: !state.agentMode });
    render();
  });
  app.append(
    el("div", { class: "row spread" }, [
      el("span", { class: "muted" }, ["Agent mode"]),
      agentBtn,
    ]),
  );
  if (state.agentMode) {
    app.append(
      el("div", { class: "banner" }, [
        "Computer-use mode is ON: connection and signing requests from connected sites are auto-approved so an agent can transact hands-free.",
      ]),
    );
  }

  // Accounts
  const list = el("div", { class: "card" }, [el("h2", {}, ["Accounts"])]);
  for (const address of state.accounts) {
    const isSelected = address === state.selectedAccount;
    const row = el("div", { class: `acct ${isSelected ? "selected" : ""}` });
    const label = el("code", { title: address }, [short(address)]);
    const bal = el("span", { class: "muted bal" }, ["…"]);
    void rpc<{ sol: number }>("popup_getBalance", { address })
      .then((b) => (bal.textContent = `${b.sol.toFixed(4)} SOL`))
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
    placeholder: "http://localhost:8787",
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
  if (msg?.type === "solana:event" && msg.event === "stateChanged") render();
});

export type { Network };
