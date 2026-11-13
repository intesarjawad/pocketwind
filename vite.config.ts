import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const design = process.env.PWT_DESIGN;

export default defineConfig({
  base: '/pocketwind/',
  build: { target: 'es2022', outDir: design ? `dist-${design}` : 'dist' },
  resolve: {
    alias: {
      '@design': fileURLToPath(
        new URL(
          design ? `./docs/design/candidates/${design}` : './src/app/styles',
          import.meta.url,
        ),
      ),
    },
  },
  define: {
    'import.meta.env.VITE_COMMIT': JSON.stringify(process.env.VITE_COMMIT ?? 'dev'),
    'import.meta.env.VITE_NUMERICS_HASH': JSON.stringify(process.env.VITE_NUMERICS_HASH ?? 'dev'),
  },
  worker: { format: 'es' },
});
