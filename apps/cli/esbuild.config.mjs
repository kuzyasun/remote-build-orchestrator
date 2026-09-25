import * as esbuild from 'esbuild';
import { EXTERNALS } from './esbuild-externals.mjs';

const buildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'bundle',
  external: EXTERNALS,
  banner: {
    js: `#!/usr/bin/env node
import * as __node_module from 'node:module';
const require = __node_module.createRequire(import.meta.url);
`,
  },
  logLevel: 'info',
};

await esbuild.build({
  ...buildOptions,
  entryPoints: {
    rbo: 'src/main.ts',
    'rbo-mcp-stdio': '../mcp-stdio/src/main.ts',
  },
  outdir: 'dist',
  entryNames: '[name]',
});
