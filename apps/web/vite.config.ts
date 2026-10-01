import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = `http://127.0.0.1:${process.env.BF_PORT ?? "3210"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: apiTarget, changeOrigin: false } },
  },
  build: { outDir: "dist", sourcemap: true },
});
