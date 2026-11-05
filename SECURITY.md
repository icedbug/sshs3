# Security Policy

The **sshs3** project takes security vulnerabilities seriously. We appreciate your efforts to responsibly disclose any security vulnerabilities you find.

---

## Supported Versions

Only the latest released minor version of sshs3 receives active security updates and patches.

| Version | Supported          |
| ------- | ------------------ |
| >= 0.9  | :white_check_mark: |
| < 0.9   | :x:                |

---

## Core Security Principles & Cryptographic Hygiene

sshs3 is built on zero-knowledge and defense-in-depth principles:
- **Ephemeral PINs and Passphrases**: Smartcard PINs, FIDO2 user verification, and key passphrases are ephemeral. They are passed directly to the OpenSSH child process via standard input and immediately discarded and garbage-collected. **They are never saved to the filesystem or logged in plaintext.**
  - **One deliberate exception:** while FIDO2 keys are unlocked in the app-wide agent (`agent-global` PIN caching mode), the FIDO2 PIN is kept in process memory so that `verify-required` keys need only a touch per signature instead of PIN + touch. The PIN is held in process memory only (never written to disk or logged), is cleared when the keys are locked or the app quits, and is never replayed after a failed attempt, so it cannot burn the authenticator's PIN retries. This applies to the FIDO2 PIN only. Other PINs and passphrases are held in memory just for the duration of a single key load (so a mechanical `ssh-add` retry does not prompt twice) and are then discarded; they are never reused for a later signature request.
- **Private Key Isolation**: Private keys on hardware security keys (YubiKey, PKCS#11, FIDO2/WebAuthn, SITHS, Net iD) **never leave the physical cryptographic hardware**. Challenge signatures are computed on-chip. Disk keys are accessed exclusively through your system's OpenSSH client or `ssh-agent`.
- **Operating System Keyring**: Any stored passwords or S3 secret keys in connection profiles are encrypted using the host OS keyring (`safeStorage`: libsecret on Linux, DPAPI on Windows, Keychain on macOS).
- **Machine policy**: administrator settings are read only from places an ordinary user cannot write (the Windows `HKLM` registry, or a `policy.conf` owned by root in a folder owned by root). Anything else is ignored with a warning, never trusted. Managed values are enforced in the main process and are never written to the user's own settings or synced to other machines. See [Enterprise Deployment & Policy](https://docs.sshs3.com/docs/reference/enterprise-deployment/).
- **Protected Local IPC**: The internal askpass mechanism uses a mode `0700` private Unix domain socket on Linux/macOS and a 128-bit cryptographically tokenized loopback interface on Windows.

For full architectural details, see [Security & smartcards in the user guide](https://docs.sshs3.com/docs/security-smartcards/).

---

## Reporting a Vulnerability

**Please do NOT report security vulnerabilities via public GitHub issues, discussions, or pull requests.**

Instead, please report security issues through one of the following channels:

1. **GitHub Private Vulnerability Reporting (Preferred)**:
   Navigate to the [Security Advisories](https://github.com/alun-hub/sshs3/security/advisories) tab of this repository and click **"Report a vulnerability"**.

2. **Email**:
   Send an email to [info@sshs3.com](mailto:info@sshs3.com) with the subject line `[SECURITY] Potential vulnerability in sshs3`.

### What to Include in Your Report

To help us investigate and triage the report promptly, please include:
- A detailed description of the vulnerability and its potential impact.
- Exact steps to reproduce the issue or a minimal proof-of-concept (PoC).
- Affected version(s) and operating system(s).
- Any recommended remediations or mitigations if you have them.

### Response Timeline

- **Initial acknowledgment**: Within 48 hours of receiving your report.
- **Triage & validation**: We will work with you to confirm the issue and assess its severity.
- **Remediation**: A fix will be developed, reviewed, and published in a security patch release.
- **Public Disclosure**: Once a patched release is published, we will coordinate public disclosure and credit you for the responsible report (unless you prefer anonymity).
