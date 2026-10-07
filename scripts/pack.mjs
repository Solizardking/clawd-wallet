import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { writeStoreZip } from "./zip-store.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const zipName = "helmsman-extension.zip";
const zipPath = join(root, zipName);
const folder = "helmsman-extension";

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function packExtensionZip({ build = false } = {}) {
  if (build || !existsSync(join(dist, "manifest.json"))) {
    const built = spawnSync("npx", ["vite", "build"], { cwd: root, stdio: "inherit", shell: true });
    if (built.status !== 0) throw new Error("extension vite build failed");
  }
  if (!existsSync(join(dist, "manifest.json"))) {
    throw new Error("dist/manifest.json missing — run npm run build");
  }

  const apiUrl = (process.env.HELMSMAN_PUBLIC_URL || "http://localhost:8787").replace(/\/$/, "");
  const rpcUrl = (process.env.HELMSMAN_RPC_URL || "").trim();
  const packed = rpcUrl ? { apiUrl, rpcUrl } : { apiUrl };
  writeFileSync(join(dist, "config.json"), `${JSON.stringify(packed, null, 2)}\n`);

  const files = walk(dist).map((abs) => ({
    name: `${folder}/${relative(dist, abs)}`,
    data: readFileSync(abs),
  }));
  writeStoreZip(files, zipPath);

  const copies = [
    join(root, "../web/public", zipName),
    join(root, "../web/dist", zipName),
  ];
  for (const dest of copies) {
    // Only mirror into a sibling web app when running inside the original monorepo.
    if (!existsSync(join(root, "../web"))) continue;
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(zipPath, dest);
    } catch {
      /* web/dist may not exist yet */
    }
  }
  return { zipPath, files: files.length, apiUrl };
}

const isMain = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isMain) {
  const result = packExtensionZip({ build: process.argv.includes("--build") });
  console.log(`packed ${result.zipPath} (${result.files} files, api ${result.apiUrl})`);
}
