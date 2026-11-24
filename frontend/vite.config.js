import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Páginas: el mapa ciudadano (/), el panel de moderación (/admin/) y el registro de visitas del equipo (/equipo/).
export default defineConfig({
  server: { fs: { allow: ['..'] } }, // permite importar ../shared en desarrollo
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin/index.html'),
        equipo: resolve(__dirname, 'equipo/index.html'),
      },
    },
  },
});
