import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The config runs in Node; typed narrowly here so the app's tsconfig needs no Node types.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

// Tauri expects a fixed port and must not have the screen cleared.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // Tauri embeds every file of dist into the exe, and a release build has no
    // devtools to read source maps; only debug builds (TAURI_ENV_DEBUG) get them.
    sourcemap: env.TAURI_ENV_DEBUG === 'true',
    chunkSizeWarningLimit: 8000,
  },
});
