import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { localModelProxy } from './server/localModelProxy';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'storyweaver-local-model-proxy',
      configureServer(server) {
        server.middlewares.use(localModelProxy());
      },
    },
  ],
  server: { host: '127.0.0.1' },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
  },
});
