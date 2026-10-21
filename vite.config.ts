import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative paths so the build works from the Python server or any static host subpath.
  base: './',
  // In development the API lives on the Python server.
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
