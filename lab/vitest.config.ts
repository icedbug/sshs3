import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The lab's own tests: they start Docker containers, so they are kept out of the product's suite
// (its config includes only tests/ and src/) and run with `npm run lab:test`.
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['lab/tests/**/*.test.ts'],
    environment: 'node',
    // A container build or a lab reset takes minutes, not seconds.
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
    // One file at a time: the files share Docker and the machine's 4 CPUs.
    fileParallelism: false,
  },
});
