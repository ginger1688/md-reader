import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // 桌面应用是从本地磁盘加载资源，不走网络。Vite 默认 500 KB 的警告阈值
    // 是给 Web 定的，这里不适用，调高以避免噪声。
    //
    // 不要为消除这个警告去配 manualChunks —— 试过，把 id 含 highlight.js 的
    // 模块归到一组会把 193 种语言全拉进同一个 chunk（981 KB），
    // 按需加载直接失效。保住代码分割比消掉一行警告重要。
    chunkSizeWarningLimit: 700,
  },
}));
