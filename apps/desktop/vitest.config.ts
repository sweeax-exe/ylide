import { defineConfig } from 'vitest/config';

// Unit tests cover pure logic (tokens, i18n, parsing); no DOM needed.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
