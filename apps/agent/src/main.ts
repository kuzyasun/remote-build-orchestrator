import { runAgent } from './run.js';

runAgent().catch((error) => {
  console.error(`rbo-agent failed: ${String(error)}`);
  process.exit(1);
});
