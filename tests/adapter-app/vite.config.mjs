import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const here = fileURLToPath(new URL(".", import.meta.url));
export default defineConfig({
  root: here,
  base: "./",
  logLevel: "warn",
  define: { "process.env.NODE_ENV": JSON.stringify("production"), global: "globalThis" },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", chunkSizeWarningLimit: 4000 },
});
