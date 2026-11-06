import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { setHeadlessUserDataPath } from './electronShim';
import { Sshs3WebServer } from './WebServer';
import { demoWorkspaceDir, isDemoMode } from '../demo/demoMode';

// This is a CLI entry point: the startup banner is meant for the operator's terminal,
// so it goes straight to stdout/stderr rather than through the levelled main-process logger.
const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
const fail = (line: string, err: unknown): void => {
  process.stderr.write(`${line} ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
};

async function main(): Promise<void> {
  const port = Number(process.env.SSHS3_WEB_PORT || process.env.PORT || 8080);
  const host = process.env.SSHS3_WEB_HOST || process.env.HOST || '0.0.0.0';
  const baseDataDir = path.resolve(
    process.env.SSHS3_DATA_DIR || path.join(os.homedir(), '.sshs3-web-server')
  );
  // Demo mode is decided once, here at server start (--demo or SSHS3_DEMO=1, see ../demo/demoMode), for
  // every user: no tenant can switch it. A demo server keeps its users, tenants and keys in its own
  // directory, so it never reads or writes the real server data.
  const demoMode = isDemoMode();
  const dataDir = demoMode ? demoWorkspaceDir(baseDataDir) : baseDataDir;

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
  out('============================================================');
  out('  sshs3 Multi-User Web Server is running!');
  out(`  URL:        http://${displayHost}:${info.port}`);
  out(`  Listen:     ${info.host}:${info.port}`);
  out(`  Data Dir:   ${dataDir}`);
  out(`  Static Dir: ${staticDir}`);
  out(`  Demo Mode:  ${demoMode ? 'on (separate demo data dir)' : 'off'}`);
  out('============================================================');

  const shutdown = async (signal: string) => {
    out(`\n[sshs3-web] Received ${signal}, shutting down gracefully...`);
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  fail('[sshs3-web] Fatal startup error:', err);
  process.exit(1);
});
