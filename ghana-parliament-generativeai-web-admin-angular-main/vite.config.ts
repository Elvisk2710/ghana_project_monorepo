/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the API runs separately; proxy /api to it so the browser stays same-origin.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': { target: 'http://localhost:3000', changeOrigin: true } } },
  test: { environment: 'jsdom', include: ['src/**/*.test.tsx'] },
});
