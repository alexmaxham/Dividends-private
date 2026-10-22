import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Relative paths so the build works on any static host subpath (GitHub Pages serves it under /Dividends-private/).
  base: './',
  // The Firebase SDK chunk is large but only loaded when the app is connected to Firebase.
  build: { chunkSizeWarningLimit: 700 },
  // Cloud Functions have their own package and test run.
  test: { exclude: [...configDefaults.exclude, 'functions/**'] },
});
