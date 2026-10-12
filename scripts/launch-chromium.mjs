#!/usr/bin/env node
// Launch Playwright's Chromium with the unpacked Clawd Wallet extension loaded
// into a dedicated, throwaway profile. Never touches your normal browser profile.
//
//   npm run box:launch                       # headed, opens https://musebook.trade
//   npm run box:launch -- --url https://solgpt.trade
//   npm run box:launch -- --verify           # headless smoke check, then exit
//   npm run box:launch -- --screenshots DIR  # headless: fresh test wallet, popup + consent screenshots
//
// Options: --headless, --keep-profile, --profile DIR (default: new temp dir, deleted on exit)
// The profile starts empty (no wallet). --screenshots creates a brand-new, unfunded
// test wallet inside the throwaway profile; its recovery phrase is never printed.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };

const url = opt("url", "https://musebook.trade");
const verify = flag("verify");
const shotDir = opt("screenshots", null);
const headless = verify || !!shotDir || flag("headless") || (!process.env.DISPLAY && process.platform === "linux");
const userProfile = opt("profile", null);
const keepProfile = flag("keep-profile") || !!userProfile;

if (!existsSync(join(dist, "manifest.json"))) {
  console.log("dist/ missing, building…");
  const built = spawnSync("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

const profile = userProfile ? resolve(userProfile) : await mkdtemp(join(tmpdir(), "clawd-wallet-profile-"));
await mkdir(profile, { recursive: true });
console.log(`profile: ${profile}${keepProfile ? "" : " (throwaway, removed on exit)"}`);

const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", // full Chromium build: required for extensions (also headless)
  headless,
  viewport: headless ? { width: 1280, height: 800 } : null,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, "--no-first-run", "--no-default-browser-check"],
});
let cleanedUp = false;
async function cleanup(code = 0) {
  if (cleanedUp) return; cleanedUp = true;
  await context.close().catch(() => {});
  if (!keepProfile) await rm(profile, { recursive: true, force: true });
  process.exit(code);
}
process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

try {
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  console.log(`extension service worker: ${worker.url()}`);
  console.log(`popup: chrome-extension://${extensionId}/popup.html`);

  if (verify || shotDir) {
    const server = createServer((_, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Clawd Wallet demo dApp</title><body style='background:#0b0b14;color:#fff;font:16px system-ui'><h1>Demo dApp</h1>"); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.waitForFunction(() => window.solana && window.clawd, null, { timeout: 10000 });
      const info = await page.evaluate(() => ({ isPhantomCompatible: !!window.solana, isConnected: window.solana.isConnected ?? false }));
      console.log(`window.solana injected: ${JSON.stringify(info)}`);

      if (shotDir) {
        const out = resolve(shotDir);
        await mkdir(out, { recursive: true });
        const popup = await context.newPage();
        await popup.setViewportSize({ width: 360, height: 600 });
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
        await popup.waitForTimeout(500);
        await popup.screenshot({ path: join(out, "popup-onboarding.png") });
        // Fresh, unfunded test wallet in the throwaway profile. Password and phrase stay in memory.
        const password = randomBytes(18).toString("base64url");
        await popup.getByPlaceholder("New password (min 8 chars)").fill(password);
        await popup.getByPlaceholder("Confirm password").fill(password);
        await popup.getByRole("button", { name: "Create new wallet" }).click();
        const saved = popup.getByRole("button", { name: /I saved it/ });
        await saved.waitFor({ timeout: 60000 }).catch(async (e) => {
          throw new Error(`wallet creation did not reach the backup step: ${(await popup.locator(".error, [role=alert]").allInnerTexts().catch(() => [])).join(" ") || (await popup.locator("body").innerText()).slice(0, 300) || e.message}`);
        });
        await saved.click(); // the phrase on the backup step is never captured or printed
        await popup.getByRole("button", { name: "Lock", exact: true }).waitFor();
        await popup.waitForTimeout(800);
        await popup.screenshot({ path: join(out, "popup-wallet.png") });
        await popup.close();

        const opened = context.waitForEvent("page", { timeout: 15000 });
        await page.evaluate(() => { window.solana.connect().catch(() => {}); });
        const consent = await opened;
        await consent.setViewportSize({ width: 360, height: 600 });
        await consent.getByRole("button", { name: "Approve", exact: true }).waitFor();
        await consent.waitForTimeout(400);
        await consent.screenshot({ path: join(out, "consent-connect.png") });
        await consent.getByRole("button", { name: "Approve", exact: true }).click();
        await page.waitForFunction(() => window.solana.isConnected || window.solana.publicKey, null, { timeout: 10000 }).catch(() => {});

        const sign = context.waitForEvent("page", { timeout: 15000 });
        await page.evaluate(() => { window.solana.signMessage(new TextEncoder().encode("gm from musebook.trade 🦞")).catch(() => {}); });
        const signPopup = await sign;
        await signPopup.setViewportSize({ width: 360, height: 600 });
        await signPopup.getByRole("button", { name: "Approve", exact: true }).waitFor();
        await signPopup.waitForTimeout(400);
        await signPopup.screenshot({ path: join(out, "consent-sign.png") });
        await signPopup.getByRole("button", { name: "Reject", exact: true }).click();
        console.log(`screenshots written to ${out}`);
      }
      console.log("verify: OK");
    } finally {
      server.close();
    }
    await cleanup(0);
  } else {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url).catch((e) => console.warn(`could not open ${url}: ${e.message}`));
    console.log(`opened ${url}. Close the browser window or press Ctrl+C to exit.`);
    context.on("close", () => cleanup(0));
  }
} catch (err) {
  console.error(err);
  await cleanup(1);
}
