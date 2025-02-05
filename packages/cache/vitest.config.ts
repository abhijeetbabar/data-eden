import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*-test.ts'],
    testTimeout: 10_000,
  },
});
