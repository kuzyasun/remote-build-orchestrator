import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Resolve workspace packages to their TypeScript sources so tests never run
// against a stale dist build.
const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  test: {
    // Snapshot capture and MCP e2e tests routinely exceed the 5s default under load.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@rbo/shared': pkg('shared'),
      '@rbo/protocol': pkg('protocol'),
      '@rbo/snapshot': pkg('snapshot'),
      '@rbo/executor': pkg('executor'),
      '@rbo/testing': pkg('testing'),
    },
  },
});
