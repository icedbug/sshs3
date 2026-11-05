## Installation, Updates & Air-Gap Lockdown

**sshs3** is packaged as a standalone desktop application for Linux distributions and Microsoft Windows. It bundles its own Electron, Chromium, Node.js, and AWS SDK runtimes with zero external dependencies. The UI executes inside an isolated, sandboxed renderer process (`nodeIntegration: false`).

---

## 1. Package Installation Matrix

Choose the native package format recommended for your operating system:

<!-- tabs:start -->
<!-- tab:Fedora (COPR) -->
```bash
sudo dnf copr enable alun-hub/sshs3
sudo dnf install -y sshs3
sshs3
```
<!-- tab:RHEL, Rocky & Fedora (.rpm) -->
```bash
sudo dnf install -y https://github.com/alun-hub/sshs3/releases/download/v{{APP_VERSION}}/sshs3-{{APP_VERSION}}.x86_64.rpm
/opt/sshs3/sshs3
```
<!-- tab:Debian & Ubuntu (.deb) -->
```bash
curl -LO https://github.com/alun-hub/sshs3/releases/download/v{{APP_VERSION}}/sshs3_{{APP_VERSION}}_amd64.deb && sudo apt install -y ./sshs3_{{APP_VERSION}}_amd64.deb
/opt/sshs3/sshs3
```
<!-- tab:Portable Linux (AppImage) -->
```bash
curl -LO https://github.com/alun-hub/sshs3/releases/download/v{{APP_VERSION}}/sshs3-{{APP_VERSION}}.AppImage && chmod +x sshs3-{{APP_VERSION}}.AppImage && ./sshs3-{{APP_VERSION}}.AppImage
```
<!-- tab:Microsoft Windows (.exe) -->
```powershell
Invoke-WebRequest -Uri "https://github.com/alun-hub/sshs3/releases/download/v{{APP_VERSION}}/sshs3-Setup-{{APP_VERSION}}.exe" -OutFile "sshs3-Setup-{{APP_VERSION}}.exe"; Start-Process ".\sshs3-Setup-{{APP_VERSION}}.exe"
```
<!-- tabs:end -->

### Installation Characteristics & Paths

| Platform / Format | Installation Path | Desktop Integration | Portable Data Mode |
| :--- | :--- | :--- | :--- |
| **RPM / DEB** | `/opt/sshs3/sshs3` | Full application menu, icons, desktop entry | `--portable-data-dir <path>` |
| **AppImage** | Self-contained executable | Direct execution (runs in place) | `--portable-data-dir <path>` |
| **Windows Installer** | `%LocalAppData%\Programs\sshs3` | Start Menu shortcut, uninstaller | Bundled portable build writes to `<exe-dir>\data` |

> [!IMPORTANT]
> **Fedora COPR:** The [COPR repository](https://copr.fedorainfracloud.org/coprs/alun-hub/sshs3/) currently provides Fedora 44 on x86_64 only. It repackages the GitHub release (the release's checksum and build-provenance attestation are verified first), is signed by COPR, and every release is built there shortly after it is published, so `dnf upgrade` installs it. If you install from COPR, let `dnf` handle updates and switch the in-app update check off (*Settings → General → App Behavior*, or `SSHS3_DISABLE_UPDATES=1`).

> [!TIP]
> **External Encrypted USB Drive:** Launch sshs3 with `--portable-data-dir <path>` (e.g. `sshs3 --portable-data-dir /media/usb/sshs3-data`) to isolate your profiles and keys entirely on an external encrypted volume.

### Security Hardening: Electron Fuses & ASAR Enforcement

Packaged binaries configure strict Electron Fuses at build time:
- `onlyLoadAppFromAsar`: Code execution is restricted strictly to the signed, read-only ASAR archive.
- `runAsNode`: Enabled solely for internal helper sub-processes (`askpass`, `certWorker.cjs`, proxy CLI) via `ELECTRON_RUN_AS_NODE=1`.
- `enableNodeCliInspectArguments` & `enableNodeOptionsEnvironmentVariable`: Disabled permanently to prevent runtime code injection or debugger hijacking via `NODE_OPTIONS`.

---

## 2. Cryptographic Integrity & Supply Chain Attestation

Every release is deterministically built on isolated GitHub Actions runners and cryptographically signed.

### Step 1: Verify Checksums
```bash
curl -LO https://github.com/alun-hub/sshs3/releases/download/v{{APP_VERSION}}/SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
```

### Step 2: Verify Sigstore Build Provenance
Verify the cryptographic build attestation using the GitHub CLI (`gh`):

<!-- tabs:start -->
<!-- tab:Debian / Ubuntu -->
```bash
gh attestation verify sshs3_{{APP_VERSION}}_amd64.deb --repo alun-hub/sshs3
```
<!-- tab:RHEL / Fedora -->
```bash
gh attestation verify sshs3-{{APP_VERSION}}.x86_64.rpm --repo alun-hub/sshs3
```
<!-- tab:AppImage -->
```bash
gh attestation verify sshs3-{{APP_VERSION}}.AppImage --repo alun-hub/sshs3
```
<!-- tabs:end -->

### Security Architecture: How Sigstore Attestation Secures the Supply Chain

Verification needs network access to the GitHub Attestations API and the Sigstore public transparency log. Build attestations link the compiled binary directly to the commit SHA and runner environment using GitHub's OIDC certificate authority. The signature is recorded on Sigstore's public Rekor transparency log, proving that the binary was not modified post-build.

---

## 3. Automatic Updates & Air-Gap Lockdown

By default, sshs3 polls GitHub Releases about 30 seconds after launch and then every 6 hours. No updates are downloaded without explicit user confirmation.

### Total Network Silence for Air-Gapped Environments

In industrial control, defense, or high-security networks where external network requests are strictly forbidden:

```bash
export SSHS3_DISABLE_UPDATES=1
/opt/sshs3/sshs3
```

When set, the internal update engine (`UpdateService`) enters permanent lockdown:
- Outbound polling is disabled.
- Release checking timers are cancelled immediately.
- *Settings → General* displays *"updates are disabled by the administrator"*.

> [!NOTE]
> On Windows, set the variable under System Properties (`sysdm.cpl` → Advanced → Environment Variables). In air-gapped environments, administrators distribute new versions manually, for example through an internal package repository.

### Environment Variables Catalog

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `SSHS3_DISABLE_UPDATES=1` | `0` | Disables update checks, release polling, and update UI completely. |
| `SSHS3_LOG_LEVEL` | `info` | Overrides logging verbosity (`debug`, `info`, `warn`, `error`). Credentials and PINs are never logged. |
| `NODE_EXTRA_CA_CERTS` | *None* | Path to internal PEM certificate bundle for corporate S3 or TLS proxies. |
| `SSH_AUTH_SOCK` | *System* | Path to an existing SSH authentication agent socket to inherit. |

---

## 4. System Requirements

sshs3 bundles its core runtime, but delegates host connectivity and smartcard communications to your operating system:

### Required Core Tools
- **OpenSSH client (`ssh`, `ssh-agent`, `ssh-add`)**: Must be available on `$PATH`.
  - Fedora / RHEL: `sudo dnf install openssh-clients`
  - Debian / Ubuntu: `sudo apt install openssh-client`
  - Arch Linux: `sudo pacman -S openssh`
  - Windows: Built-in OpenSSH Client (*Settings → Apps → Optional features*).
- **OS Keyring** for credential storage: `libsecret` (GNOME Keyring / KWallet) on Linux; Windows DPAPI on Windows.

### Optional Hardware Token Drivers
- **FIDO2 Keys (`ed25519-sk` / `ecdsa-sk`)**: OpenSSH 8.2+ with FIDO2 support. Optional `ykman` for resident key inspection.
- **PKCS#11 Smartcards (PIV / CAC / SITHS)**:
  - Fedora / RHEL: `sudo dnf install pcsc-lite pcsc-lite-ccid && sudo systemctl enable --now pcscd`
  - Debian / Ubuntu: `sudo apt install pcscd pcsc-tools libccid && sudo systemctl enable --now pcscd`
  - Supported PKCS#11 modules: `p11-kit` (recommended proxy), `libykcs11`, Net iD (`libiidp11.so`), and OpenSC.

---

## 5. Troubleshooting Runbook

| Symptom | Root Cause | Immediate Fix |
| :--- | :--- | :--- |
| `dlopen(): error loading libfuse.so.2` | Modern Linux missing FUSE compatibility library | Run `sudo apt install libfuse2t64` (Ubuntu/Debian) and relaunch AppImage. |
| `error while loading shared libraries: libasound.so.2` (or `libgbm.so.1`) | A package older than the release that declares them, or a `.deb` installed with `dpkg -i`, which does not install missing dependencies | Run `sudo apt install libasound2t64 libgbm1` (Ubuntu 24.04+, Debian 13; `libasound2` on older releases) or `sudo dnf install alsa-lib mesa-libgbm` (Fedora/RHEL). Installing with `sudo apt install ./sshs3_<version>_amd64.deb` pulls them in automatically. |
| Windows SmartScreen Warning | Commercial EV certificate not attached | Click **More info** → **Run anyway**. Validate against `SHA256SUMS`. |
| `Cannot connect to X server` (Linux) | Display mismatch or forced `--ozone-platform=x11` on Wayland | Launch with `--ozone-platform=wayland` in Wayland desktop sessions. |
| Update toggle disabled in Settings | `SSHS3_DISABLE_UPDATES=1` is active in environment | Unset the variable in `/etc/environment` or user profile if updates are desired. |
