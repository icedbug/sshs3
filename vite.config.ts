/// <reference types="vitest" />
import { defineConfig } from 'vite'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const windowsCI = process.platform === 'win32' && Boolean(process.env.CI)
const availableCpus = os.availableParallelism()
const testCpus = windowsCI ? Math.max(1, availableCpus - 1) : availableCpus

function copyProxyCliPlugin() {
  return {
    name: 'copy-proxy-cli',
    closeBundle() {
      const src = path.resolve(import.meta.dirname, 'src/main/proxy/proxyCli.cjs')
      const dest = path.resolve(import.meta.dirname, 'dist-electron/proxyCli.cjs')
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
      }
    },
  }
}

function copyCertWorkerPlugin() {
  return {
    name: 'copy-cert-worker',
    closeBundle() {
      const src = path.resolve(import.meta.dirname, 'src/main/smartcard/certWorker.cjs')
      const dest = path.resolve(import.meta.dirname, 'dist-electron/certWorker.cjs')
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
      }
    },
  }
}

function copyOcShimCliPlugin() {
  return {
    name: 'copy-oc-shim-cli',
    closeBundle() {
      const src = path.resolve(import.meta.dirname, 'src/main/services/ocShimCli.cjs')
      const dest = path.resolve(import.meta.dirname, 'dist-electron/ocShimCli.cjs')
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(src, dest)
      }
    },
  }
}

export default defineConfig({
  base: './',
  plugins: [
    tailwindcss(),
    react(),
    copyProxyCliPlugin(),
    copyCertWorkerPlugin(),
    copyOcShimCliPlugin(),
    electron({
      main: {
        entry: 'src/main/desktopEntry.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rolldownOptions: {
              external: [
                'node-pty',
                'pkcs11js',
                '@aws-sdk/client-s3',
                '@aws-sdk/lib-storage',
                '@kubernetes/client-node',
              ],
            },
          },
        },
      },
      preload: {
        input: 'src/preload/index.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rolldownOptions: {
              output: {
                format: 'cjs',
                entryFileNames: '[name].cjs',
              },
            },
          },
        },
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/xterm') || id.includes('node_modules/@xterm')) {
            return 'xterm-bundle';
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'icons-bundle';
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'react-vendor';
          }
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src/renderer/src'),
      '@shared': path.resolve(import.meta.dirname, 'src/shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/release/**', '**/dist/**', '**/dist-electron/**', '**/dist-web/**', '**/dist-web-ui/**'],
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx,js,cjs,mjs}', 'src/**/*.test.{ts,tsx}'],
    // Reserve memory for the coordinator and cap concurrent DOM workers on small runners.
    maxWorkers: Math.max(1, Math.min(testCpus, Math.floor(((process.availableMemory?.() || os.freemem()) - 512 * 1024 ** 2) / (768 * 1024 ** 2)))),
    // Hosted Windows workers share CPU with Git, Electron and native crypto processes.
    // Keep the harness deadline separate from deadlines asserted by individual tests.
    ...(windowsCI ? { testTimeout: 20_000 } : {}),
    globals: true,
    environment: 'node',
    // A home folder per test file: no test reads or writes the real one (see the file).
    // And a demo lab of its own per test: no test starts with the simulated servers an earlier one left.
    setupFiles: ['tests/setup/isolateHome.ts', 'tests/setup/freshLab.ts'],
    globalSetup: ['tests/setup/homeRoot.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx,cjs}'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'lcov'],
      // Ratchet: set just under the measured values so coverage can't silently drop.
      // Raise these when tests are added; never lower them to make a build pass.
      // Measured on Linux: lines 82.3, statements 79.6, functions 74.8, branches 71.5. A margin of about three
      // points is left for runners that skip tests this machine runs (real shells, OpenSSH, age).
      thresholds: {
        lines: 79,
        statements: 76,
        functions: 71,
        branches: 68,
        // The AI hub (87.9 measured) and the web server (91.8): the agent's tools and the account boundary.
        'src/main/ai/hub/**': { lines: 85 },
        'src/main/web/**': { lines: 89 },
        // Security-sensitive areas get their own floor.
        'src/main/crypto/**': { lines: 95 },
        'src/main/smartcard/**': { lines: 87 },
        'src/main/proxy/**': { lines: 84 },
        'src/main/services/**': { lines: 81 },
        'src/main/dotfiles/**': { lines: 88 },
        'src/main/ssh/**': { lines: 85 },
        'src/main/IpcBridge.ts': { lines: 58 },
      },
    },
  },
})
