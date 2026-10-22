import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { devUploadPlugin } from './dev-server';

// Relative base: the build works from any path or local folder (the server serves it from the domain root).
export default defineConfig({
  base: './',
  plugins: [devUploadPlugin()],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        home: resolve(__dirname, 'index.html'),
        predigt: resolve(__dirname, 'apps/predigt-schnitt/index.html'),
        termine: resolve(__dirname, 'apps/termine/index.html'),
        // weitere Apps hier ergänzen
      },
    },
  },
  worker: { format: 'es' },
  test: { include: ['tests/**/*.test.ts'] },
} as any);
