import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { setHeadlessUserDataPath } from './electronShim';
import { Sshs3WebServer } from './WebServer';

async function main(): Promise<void> {
  const port = Number(process.env.SSHS3_WEB_PORT || process.env.PORT || 8080);
  const host = process.env.SSHS3_WEB_HOST || process.env.HOST || '0.0.0.0';
  const dataDir = path.resolve(
    process.env.SSHS3_DATA_DIR || path.join(os.homedir(), '.sshs3-web-server')
  );

  // Resolve static frontend directory (dist/)
  const candidates = [
    process.env.SSHS3_STATIC_DIR ? path.resolve(process.env.SSHS3_STATIC_DIR) : '',
    path.resolve(import.meta.dirname, '../dist'),
    path.resolve(process.cwd(), 'dist'),
  ].filter(Boolean);

  const staticDir = candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) || candidates[1];

  fs.mkdirSync(dataDir, { recursive: true });
  setHeadlessUserDataPath(dataDir);

  const server = new Sshs3WebServer({
    port,
    host,
    dataDir,
    staticDir,
  });

  const info = await server.start();
  const displayHost = info.host === '0.0.0.0' ? 'localhost' : info.host;
  console.log('============================================================');
  console.log('  sshs3 Multi-User Web Server is running!');
  console.log(`  URL:        http://${displayHost}:${info.port}`);
  console.log(`  Listen:     ${info.host}:${info.port}`);
  console.log(`  Data Dir:   ${dataDir}`);
  console.log(`  Static Dir: ${staticDir}`);
  console.log('============================================================');

  const shutdown = async (signal: string) => {
    console.log(`\n[sshs3-web] Received ${signal}, shutting down gracefully...`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[sshs3-web] Fatal startup error:', err);
  process.exit(1);
});
