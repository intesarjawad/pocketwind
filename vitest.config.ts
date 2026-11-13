import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    benchmark: { include: ['tests/unit/**/*.bench.ts'] },
  },
});
