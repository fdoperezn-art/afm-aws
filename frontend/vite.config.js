import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Dos páginas: el mapa ciudadano (/) y el panel de moderación (/admin/).
export default defineConfig({
  server: { fs: { allow: ['..'] } }, // permite importar ../shared en desarrollo
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin/index.html'),
      },
    },
  },
});
