import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 8080,
    host: true,
    allowedHosts: ['gp1.uptimehost.in', '.uptimehost.in'],
    proxy: {
      '/api': 'http://localhost:8081',
      '/ws': { target: 'ws://localhost:8081', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    // Hashed assets are content-addressed + immutable: keep previous builds'
    // chunks on disk instead of wiping dist so tabs already open across a
    // redeploy can still fetch their lazy chunks. Old files are pruned by
    // scripts/prune-dist.mjs (mtime older than 30 days).
    emptyOutDir: false,
  },
})
