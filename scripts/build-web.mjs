import { build } from 'vite';
import path from 'node:path';
import fs from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const gzipAsync = promisify(gzip);

async function buildClient() {
  const outDir = path.join(rootDir, 'dist-web-ui');
  await build({
    configFile: false,
    root: rootDir,
    base: './',
    plugins: [tailwindcss(), react()],
    resolve: {
      alias: {
        '@': path.resolve(rootDir, 'src/renderer/src'),
        '@shared': path.resolve(rootDir, 'src/shared'),
      },
    },
    build: {
      outDir,
      emptyOutDir: true,
    },
  });

  const assetsDir = path.join(outDir, 'assets');
  for (const file of await fs.readdir(assetsDir)) {
    if (!/\.(?:js|css)$/.test(file)) continue;
    const source = path.join(assetsDir, file);
    const bytes = await fs.readFile(source);
    if (bytes.length >= 1024) await fs.writeFile(source + '.gz', await gzipAsync(bytes));
  }
}

async function buildServer() {
  // The server says which version it is (web/appVersion.ts): written into the bundle here.
  const { version } = JSON.parse(await fs.readFile(path.join(rootDir, 'package.json'), 'utf8'));
  await build({
    configFile: false,
    root: rootDir,
    // public/ holds the page's icon and manifest. They belong to the client build (dist-web-ui/),
    // which the server serves from. Copied here too, nothing read them.
    publicDir: false,
    define: { __SSHS3_VERSION__: JSON.stringify(version) },
    resolve: {
      alias: {
        electron: path.resolve(rootDir, 'src/main/web/electronShim.ts'),
        '@': path.resolve(rootDir, 'src/renderer/src'),
        '@shared': path.resolve(rootDir, 'src/shared'),
      },
    },
    ssr: {
      noExternal: true,
      external: [
        'node-pty',
        'pkcs11js',
        '@aws-sdk/client-s3',
        '@aws-sdk/lib-storage',
        '@aws-sdk/client-sso',
        '@aws-sdk/client-sso-oidc',
        '@aws-sdk/credential-provider-sso',
        '@aws-sdk/s3-request-presigner',
        '@kubernetes/client-node',
        'electron-updater',
        'win-ca',
      ],
    },
    build: {
      ssr: path.resolve(rootDir, 'src/main/web/serverEntry.ts'),
      outDir: path.resolve(rootDir, 'dist-web'),
      emptyOutDir: true,
      rolldownOptions: {
        output: {
          format: 'esm',
          entryFileNames: 'server.mjs',
          // The parts the server loads when it first needs them (reading a PDF, a web page). The
          // default folder name is "assets", which looked like files for the browser.
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
      },
    },
  });

  // Copy helper CJS scripts into dist-web/
  const helpers = [
    ['src/main/proxy/proxyCli.cjs', 'dist-web/proxyCli.cjs'],
    ['src/main/smartcard/certWorker.cjs', 'dist-web/certWorker.cjs'],
    ['src/main/services/ocShimCli.cjs', 'dist-web/ocShimCli.cjs'],
  ];
  for (const [srcRel, destRel] of helpers) {
    const src = path.resolve(rootDir, srcRel);
    const dest = path.resolve(rootDir, destRel);
    await fs.copyFile(src, dest);
  }
}

const target = process.argv[2] ?? 'all';
if (!['all', 'client', 'server'].includes(target)) throw new Error('Choose all, client or server.');
await Promise.all([
  ...(target !== 'server' ? [buildClient()] : []),
  ...(target !== 'client' ? [buildServer()] : []),
]);
