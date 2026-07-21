import { createLogger } from '@rbo/shared';
import { runController } from './run.js';

const logger = createLogger('controller.main');

runController().catch((error) => {
  logger.error('controller failed to start', { error: String(error) });
  process.exit(1);
});
