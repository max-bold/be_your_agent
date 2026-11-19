import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';
import { createWorkbenchServer } from './server.js';

async function main() {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const port = Number(process.env.PORT ?? 4320);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be between 1 and 65535');
  const service = await createWorkbenchServer({
    directory: resolve(process.env.DATA_DIR ?? '.data'),
    apiToken: process.env.API_TOKEN,
    // Resolve against the working directory for both tsx and compiled startup.
    webDirectory: resolve('web'),
  });
  await new Promise<void>((resolve, reject) => {
    service.server.once('error', reject);
    service.server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`be_your_agent: http://127.0.0.1:${port}`);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void service.close().then(
        () => process.exit(0),
        (error) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
