import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The ZtpkiPage calls `fetch('/api/ztpki')`. In dev, proxy /api to the
// standalone proxy server (api/server.cjs, default :3001), stripping /api.
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    proxy: {
      '/api': {
        target: process.env.ZTPKI_API || 'http://127.0.0.1:3001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
