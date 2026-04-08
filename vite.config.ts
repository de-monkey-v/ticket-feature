import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const webPort = Number(process.env.VITE_PORT?.trim() || '5173')
const webHost = process.env.VITE_HOST?.trim() || '0.0.0.0'
const apiTarget = process.env.VITE_API_TARGET?.trim() || 'http://localhost:4000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/web',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
  server: {
    host: webHost,
    port: webPort,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
})
