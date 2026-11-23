import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BACKEND=http://localhost:8000 npm run dev proxies /api and /mcp to a local API; without it, open the app with ?mock.
const backend = process.env.BACKEND;
export default defineConfig({
  plugins: [react()],
  server: { proxy: backend ? { '/api': backend, '/mcp': backend } : undefined },
  build: { target: 'es2020' },
});
