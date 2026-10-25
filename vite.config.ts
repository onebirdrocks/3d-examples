import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  base: './',
  server: {
    port: 5173,
    host: true,
  },
  preview: {
    port: 4173,
    host: true,
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 4096,
    rollupOptions: {
      input: {
        main: r('./index.html'),
        scene: r('./scene.html'),
      },
    },
  },
});
