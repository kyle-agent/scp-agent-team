import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const adapter = process.env.VITE_ADAPTER_URL ?? 'http://127.0.0.1:8090';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Same-origin in dev, so the SSE stream is not subject to CORS preflight.
      '/agui': { target: adapter, changeOrigin: true },
      '/api': { target: adapter, changeOrigin: true },
    },
  },
});
