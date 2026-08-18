/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { SERVER_PARAMS } from './shared/constants.js'

const serverOrigin = `http://localhost:${SERVER_PARAMS.SERVER_PORT}`
const serverWsOrigin = `ws://localhost:${SERVER_PARAMS.SERVER_PORT}`

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Exact prefixes only — a catch-all `ws: true` rule would also intercept
      // Vite's own HMR WebSocket.
      '/api/': {
        target: serverOrigin,
        changeOrigin: true,
      },
      '/ws': {
        target: serverWsOrigin,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
  },
})
