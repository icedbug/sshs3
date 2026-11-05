# Contributing to sshs3

Thank you for your interest in contributing to **sshs3**! We welcome bug reports, documentation improvements, feature suggestions, and code contributions.

Please take a moment to review this document to ensure a smooth collaboration.

---

## Code of Conduct

All contributors and maintainers are expected to adhere to our [Code of Conduct](CODE_OF_CONDUCT.md). Please report any unacceptable behavior to [info@sshs3.com](mailto:info@sshs3.com).

---

## How Can I Contribute?

### Reporting Bugs

Before submitting a bug report:
- Search existing [GitHub Issues](https://github.com/alun-hub/sshs3/issues) to see if the problem has already been reported.
- Ensure you are running the latest version of sshs3.

When filing an issue, please use our [Bug Report Template](.github/ISSUE_TEMPLATE/bug_report.md) and include:
- A clear, descriptive title.
- Steps to reproduce the problem.
- Expected vs. actual behavior.
- Operating system, version, and architecture (Linux, Windows, macOS).
- Relevant terminal logs or error stack traces.

### Suggesting Enhancements

Feature requests are very welcome! Please use our [Feature Request Template](.github/ISSUE_TEMPLATE/feature_request.md) and describe:
- The problem your proposal solves or use case it addresses.
- Your proposed solution or workflow.
- Any alternatives or trade-offs you considered.

---

## Development Setup

### Prerequisites

- **Node.js**: 20.x or higher (LTS recommended)
- **npm**: 10.x or higher
- **C/C++ toolchain**: Required to compile native modules such as `node-pty` (via `node-gyp`).
  - *Ubuntu/Debian*: `sudo apt-get install build-essential python3`
  - *Fedora/RHEL*: `sudo dnf groupinstall "Development Tools"`
  - *Windows*: Visual Studio Build Tools with C++ workload (`npm install -g windows-build-tools` or via Visual Studio Installer)

### Getting Started

1. **Fork and clone**:
   ```bash
   git clone https://github.com/<your-username>/sshs3.git
   cd sshs3
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start development mode**:
   ```bash
   npm run dev
   ```

### Architecture & Codebase Overview

Before writing new features or modifying IPC interfaces, please read [`ARCHITECTURE.md`](ARCHITECTURE.md). It outlines:
- Process boundaries between Electron Main, Preload (`contextBridge`), and React Renderer.
- Asynchronous streaming contract for [`IStorageProvider`](src/main/storage/StorageProvider.ts).
- Terminal PTY lifecycle, proxy routing, and Askpass security boundaries.

### User Documentation & Guides (`docs.sshs3.com`)

User documentation is maintained in Markdown under [`docs/user-guide/`](docs/user-guide/) — the **single source**, in English, written next to the code it describes (see its [README](docs/user-guide/README.md) for the page registry, conventions and writing rules). It is rendered and published to [docs.sshs3.com](https://docs.sshs3.com) by the site repo's build.
- Any PR introducing or changing user-facing functionality (new shortcuts, connection options, file manager features, settings, etc.) **must update or add to the relevant page** in `docs/user-guide/`. Verify button and setting names against the UI and `src/shared/types/settings.ts`.
- Validate documentation locally using `npm run docs:sync`.
- Merging to `master` only validates the documentation (`.github/workflows/deploy-docs.yml`). It goes live with `scripts/deploy-site.sh`, which `scripts/deploy.sh` runs automatically after a release when `docs/` (or `ipc.ts`/`settings.ts`) changed; it can also be run on its own.

---

## Code Standards & Style

### Git Commit Guidelines

We adhere to the [Conventional Commits](https://www.conventionalcommits.org/) specification:

- `feat:` Adds a new feature
- `fix:` Patches a bug
- `refactor:` Code changes that neither fix a bug nor add a feature
- `perf:` Performance improvements
- `docs:` Documentation changes
- `test:` Adding or updating tests
- `chore:` Build scripts, package updates, configuration

*Example*: `feat(ssh): add auto-reconnect option for dropped terminal sessions`

### Linting & Formatting

Always ensure your code passes static checks before opening a pull request:

```bash
# Verify TypeScript types
npm run typecheck

# Run ESLint
npm run lint

# Run all automated tests
npm run test
```

### Conventions & Standards

- **Release Versioning**: When releasing new versions, use only a single segment after the dot (e.g. `0.2`, `0.3`, `0.96.1` instead of `0.2.19`) to ensure correct sorting in GitHub Releases.
- **Date Formatting**: Always format timestamps across UI and logs as `yyyy-mm-dd HH:mm` (24h).
- **Security & Ephemeral Secrets**: Never log or store PINs, passphrases, or private keys on disk or in persistent memory.

### Packaging

```bash
npm run package:appimage   # Linux AppImage only
npm run package:linux      # AppImage, deb and rpm (needs `rpm` installed for the RPM)
npm run package:win        # Windows (needs a Windows build environment)
```

#### Building on Windows
- `node-pty` and `pkcs11js` are native modules. A full rebuild needs **Python** and the **Visual C++ build tools**; without them `electron-builder` stops at `Could not find any Python installation to use`.
- `node-pty` ships prebuilt Windows binaries, so `npx electron-builder --win --config.npmRebuild=false` works, but `pkcs11js` is then *not* built. Smartcard certificate details fall back to OpenSC's `pkcs11-tool.exe` (see the Windows page of the user guide).
- `npm install --ignore-scripts` skips these native builds too.

### Automated Releases

Releases can be deployed automatically via:
```bash
npm run deploy
# or
./scripts/deploy.sh "chore: release notes"
```

---

## Pull Request Process

1. Create a feature branch from `master`:
   ```bash
   git checkout -b feat/my-new-feature
   ```
2. Implement your changes, adding automated unit or integration tests wherever applicable.
3. Verify that `npm run typecheck`, `npm run lint`, and `npm run test` pass with 0 errors.
4. Push your branch to your fork and submit a Pull Request to `master`.
5. Fill out the [Pull Request Template](.github/pull_request_template.md) describing the changes, tests performed, and any related issues.
6. Address review comments promptly. Once approved and CI checks pass, your changes will be merged!
