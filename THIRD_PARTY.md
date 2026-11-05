# Built on open source

sshs3 wouldn't exist without these projects:

| Project | Role |
| :--- | :--- |
| [Electron](https://www.electronjs.org/) | Cross-platform desktop app shell (Chromium + Node.js) |
| [React](https://react.dev/) | Renderer UI |
| [xterm.js](https://xtermjs.org/) (`xterm`, `@xterm/addon-fit`) | In-browser terminal emulator that renders the PTY output |
| [@xterm/addon-search](https://www.npmjs.com/package/@xterm/addon-search) | Real-time text search for terminal logs and output panes |
| [node-pty](https://github.com/microsoft/node-pty) | Spawns and drives the real `ssh`/shell process as a pseudo-terminal |
| [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@aws-sdk/s3-request-presigner`) | S3-compatible object storage operations (AWS, MinIO, NetApp StorageGRID, etc.) |
| [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) (`@aws-sdk/client-sso`, `@aws-sdk/client-sso-oidc`, `@aws-sdk/credential-provider-sso`) | AWS SSO (IAM Identity Center) device-authorization login, account/role listing, and temporary credentials |
| [@kubernetes/client-node](https://github.com/kubernetes-client/javascript) | Kubernetes client for cluster discovery, WebSocket exec sessions, and log streams |
| [pkcs11js](https://github.com/PeculiarVentures/pkcs11js) | Native PKCS#11 bindings for reading smartcard certificates directly from hardware modules |
| [win-ca](https://github.com/ukoloff/win-ca) | Reads the Windows certificate store so corporate/self-signed CAs are trusted |
| [Tailwind CSS](https://tailwindcss.com/) | Utility-first styling for the renderer UI |
| [lucide-react](https://lucide.dev/) | Icon set used throughout the UI |
| [TanStack Virtual](https://tanstack.com/virtual) | Virtualized rendering for large file listings |
| [react-markdown](https://github.com/remarkjs/react-markdown) + [remark-gfm](https://github.com/remarkjs/remark-gfm) | Lazy-loaded Markdown preview in the in-app file editor |
| [Vite](https://vitejs.dev/) + [vite-plugin-electron](https://github.com/electron-vite/vite-plugin-electron) | Dev server and build tooling for renderer, main, and preload bundles |
| [TypeScript](https://www.typescriptlang.org/) | Strict typing shared across main/preload/renderer via `src/shared/types` |
| [Vitest](https://vitest.dev/) + [Testing Library](https://testing-library.com/) | Unit and component test suite |
| [ESLint](https://eslint.org/) + [typescript-eslint](https://typescript-eslint.io/) | Linting |
| [electron-builder](https://www.electron.build/) + [electron-updater](https://www.electron.build/auto-update) | Packaging (AppImage/deb/rpm for Linux, NSIS/portable/ZIP for Windows), GitHub Releases publishing and in-app updates |
