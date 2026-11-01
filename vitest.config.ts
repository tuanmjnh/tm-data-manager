import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // `node:sqlite` is new in Node 22 and Vite's builtin list may not know it.
    // Marking it external keeps Node's own loader in charge.
    server: {
      deps: {
        external: [/node:sqlite/],
      },
    },
  },
});
