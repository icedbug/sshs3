/// <reference types="vitest" />
import { defineConfig } from 'vite'
import path from 'node:path'
import fs from 'node:fs'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

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
      ignored: ['**/release/**', '**/dist/**', '**/dist-electron/**'],
    },
  },
  test: {
    include: ['tests/**/*.test.{ts,tsx,js,cjs,mjs}'],
    globals: true,
    environment: 'node',
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx,cjs}'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'lcov'],
      // Ratchet: set just under the measured values so coverage can't silently drop.
      // Raise these when tests are added; never lower them to make a build pass.
      thresholds: {
        lines: 65,
        statements: 63,
        functions: 51,
        branches: 52,
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
