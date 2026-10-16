// Minimal @solana/wallet-adapter-react dApp. wallets={[]} relies purely on
// Wallet Standard discovery. Devnet only; transactions are signed, never sent.
import { Buffer } from "buffer";
globalThis.Buffer = Buffer;
import { createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import bs58 from "bs58";

function Panel() {
  const { publicKey, wallets, wallet, signMessage, signTransaction, connected, connect } = useWallet();
  window.__connect = () => connect().then(() => "ok", (e) => String(e?.name) + ": " + String(e?.message) + " " + String(e?.error?.message));
  const [out, setOut] = useState("");
  window.__adapter = { wallets: wallets.map((w) => ({ name: w.adapter.name, readyState: w.readyState })), selected: wallet?.adapter.name ?? null, publicKey: publicKey?.toBase58() ?? null, connected };
  const doSign = async () => {
    try {
      const sig = await signMessage(new TextEncoder().encode("wallet-adapter compatibility test"));
      setOut(JSON.stringify({ kind: "message", signature: bs58.encode(sig) }));
    } catch (e) { setOut(JSON.stringify({ error: e.message })); }
  };
  const doTx = async () => {
    try {
      const tx = new Transaction({ recentBlockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", feePayer: publicKey })
        .add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: new PublicKey("59dqcH5gJr6M2R5hFtmmXUfNmgGJWfQh8Gx33fnAReKo"), lamports: 1000 }));
      const signed = await signTransaction(tx);
      setOut(JSON.stringify({ kind: "tx", verified: signed.verifySignatures(), tx: signed.serialize().toString("base64") }));
    } catch (e) { setOut(JSON.stringify({ error: e.message })); }
  };
  return h("div", null,
    h(WalletMultiButton),
    h("p", null, connected ? `Connected: ${publicKey.toBase58()}` : "Not connected"),
    h("button", { id: "sign-message", onClick: doSign, disabled: !connected }, "Sign message"),
    h("button", { id: "sign-tx", onClick: doTx, disabled: !connected }, "Sign devnet transaction"),
    h("pre", { id: "out" }, out));
}

createRoot(document.getElementById("root")).render(
  h(ConnectionProvider, { endpoint: "https://api.devnet.solana.com" },
    h(WalletProvider, { wallets: [], autoConnect: false, onError: (e) => { (window.__adapterErrors ||= []).push(String(e?.name) + ": " + String(e?.message)); } },
      h(WalletModalProvider, null, h(Panel)))));
