import { build } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function buildWeb() {
  console.log('[build-web] 1/2 Building React SPA frontend -> dist/ ...');
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
      outDir: path.resolve(rootDir, 'dist'),
      emptyOutDir: true,
    },
  });

  console.log('[build-web] 2/2 Building Multi-User Web Server -> dist-web/server.mjs ...');
  await build({
    configFile: false,
    root: rootDir,
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
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    }
  }

  console.log('[build-web] Done! Start with: npm run start:web');
}

buildWeb().catch((err) => {
  console.error('[build-web] Build failed:', err);
  process.exit(1);
});
