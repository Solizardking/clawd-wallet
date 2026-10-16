import { defineConfig } from "vite";
import { resolve } from "node:path";

// injected.js runs as a classic MAIN-world script: wrap it so none of its
// top-level bindings leak into the page's global scope (fingerprinting).
const wrapInjected = {
  name: "clawd-wrap-injected",
  generateBundle(_opts: unknown, bundle: Record<string, { type: string; code?: string }>) {
    const chunk = bundle["injected.js"];
    if (chunk?.type !== "chunk" || !chunk.code) return;
    if (/^\s*(import|export)\b/m.test(chunk.code)) throw new Error("injected.js must not import/export");
    chunk.code = `(()=>{"use strict";\n${chunk.code}\n})();\n`;
  },
};

export default defineConfig({
  plugins: [wrapInjected],
  define: {
    global: "globalThis",
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background.ts"),
        content: resolve(__dirname, "src/content.ts"),
        injected: resolve(__dirname, "src/injected.ts"),
        popup: resolve(__dirname, "src/popup.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
