// Offline checks for the Clawd Chain port: PoW, name resolution, local signing.
import assert from "node:assert/strict";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { Keypair } from "@solana/web3.js";
import { leadingZeros, powHash, solvePow } from "./pow.js";
import { parseMintAccount, resolveHoldings, accountRows } from "./names.js";
import { buildSignedTransfer, formatClawd, explorerAddressUrl } from "./chain.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
assert.equal(hex(powHash("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.equal(leadingZeros(new Uint8Array([0, 0x0f])), 12);
const r = await solvePow("test-challenge", 12);
assert.ok(leadingZeros(powHash(`test-challenge:${r.nonce}`)) >= 12);

assert.equal(parseMintAccount({ value: { data: { parsed: { info: { extensions: [{ state: { name: " Claw " } }] } } } } }), "Claw");
assert.equal(parseMintAccount(null), null);
assert.deepEqual(resolveHoldings([{ mint: "M", balance: "5" }], { M: "Pinch" }), [{ mint: "M", name: "Pinch", balance: "5" }]);
assert.deepEqual(accountRows({ value: [{ account: { data: { parsed: { info: { mint: "M", tokenAmount: { amount: "7" } } } } } }] }), [{ mint: "M", balance: "7" }]);

assert.equal(formatClawd(1_500_000_000), "1.5");
assert.equal(formatClawd(5_000_000_000n), "5");
assert.ok(explorerAddressUrl("abc").startsWith("https://explorer.clawdchain.trade/address/"));

const kp = Keypair.generate();
const s = buildSignedTransfer(kp, " Recip ", "2");
assert.deepEqual(JSON.parse(s.payload), { sender: kp.publicKey.toBase58(), recipient: "Recip", amount: "2", network: "clawd" });
assert.ok(nacl.sign.detached.verify(new TextEncoder().encode(s.payload), Buffer.from(s.signature, "hex"), bs58.decode(s.publicKey)));
assert.throws(() => buildSignedTransfer(kp, "", "1"));
assert.throws(() => buildSignedTransfer(kp, "x", "-1"));
console.log("clawd vectors ok");
