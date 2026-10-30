import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [preact()],
  server: {
    port: 5319,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8460', ws: true, changeOrigin: true },
      '/media': { target: 'http://127.0.0.1:8460', changeOrigin: true },
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
