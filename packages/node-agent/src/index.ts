import { bootstrap } from './bootstrap';

bootstrap().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[bootstrap] Fatal error: ${msg}`);
  process.exit(1);
});
