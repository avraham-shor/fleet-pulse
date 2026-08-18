/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { SERVER_PARAMS } from './shared/constants.js'

// Follows the same PORT env var server.js reads (falling back to the same
// SERVER_PARAMS.SERVER_PORT default), so `PORT=4000 npm start` points both
// the mock server and this dev proxy at :4000 without a second place to edit.
const envPort = Number(process.env.PORT)
const serverPort = Number.isFinite(envPort) && envPort > 0 ? envPort : SERVER_PARAMS.SERVER_PORT
const serverOrigin = `http://localhost:${serverPort}`
const serverWsOrigin = `ws://localhost:${serverPort}`

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
