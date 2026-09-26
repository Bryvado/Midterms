import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/' : '/Midterms/',
  build: { outDir: 'dist', emptyOutDir: true },
}));
