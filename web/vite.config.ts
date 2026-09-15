import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Production build is served by the Harbor daemon from web/dist under a strict CSP
// (no inline scripts/styles). The dev server proxies the API to a running daemon and
// rewrites Origin/Host so the daemon's same-origin checks accept it.
const daemon = process.env['HARBOR_DEV_URL'] ?? 'http://localhost:18000';

export default defineConfig({
  root: path.resolve(import.meta.dirname),
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022', chunkSizeWarningLimit: 800 },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': { target: daemon, changeOrigin: true, headers: { origin: daemon } },
      '/healthz': { target: daemon, changeOrigin: true },
    },
  },
});
