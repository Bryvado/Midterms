import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : '/Midterms/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), methodology: resolve(import.meta.dirname, 'methodology.html') } },
  },
}));
