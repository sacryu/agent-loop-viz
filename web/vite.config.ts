import { defineConfig } from "vite";
// 开发时（npm run dev -w web）：页面由 Vite 提供，/ws 和 /v1 转给本机的服务器
// 演示站（npm run build:demo）：--mode demo，页面默认进演示、不连服务器；BASE 是 GitHub Pages 上仓库名的路径（如 /agent-loop/）
export default defineConfig(({ mode }) => ({
  base: process.env.BASE || (mode === "demo" ? "./" : "/"),
  server: { proxy: { "/ws": { target: "ws://127.0.0.1:4317", ws: true }, "/v1": "http://127.0.0.1:4317", "/healthz": "http://127.0.0.1:4317" } },
  build: { outDir: mode === "demo" ? "dist-demo" : "dist", emptyOutDir: true, target: "es2022" },
}));
