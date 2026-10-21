import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { devUploadPlugin } from './dev-server';

// Relative base: the build works under https://NAME.github.io/audio-tools/ as well as
// from any local folder or `vite preview`.
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
