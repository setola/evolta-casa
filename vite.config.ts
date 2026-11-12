import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// IP literals and localhost are accepted by Vite. Add only trusted LAN names;
// never disable host validation globally with allowedHosts: true.
const allowedHosts = [
  process.env.DEV_HOST ?? 'evolta-casa.local',
  ...(process.env.DEV_ALLOWED_HOSTS ?? '').split(','),
].map(host => host.trim()).filter(Boolean);

export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  server: {
    allowedHosts,
    strictPort: true,
    fs: {
      // Retain Vite's secret-file exclusions and never serve local CA keys/caches.
      deny: ['.env', '.env.*', '*.{crt,pem,key}', '**/.git/**', '**/.docker/**'],
    },
  },
  preview: { allowedHosts, strictPort: true },
  // No fixed HMR host/clientPort: use the browser origin through NAT or TLS proxy.
  build: { target: 'es2022' },
});
