/**
 * Which file paths may hold a secret: keys, passwords, tokens.
 *
 * This looks at a path and nothing else. It does not read commands, and it stops nothing by itself:
 * a caller that will not hand such a file to a tool asks here (see `sensitiveFile` in chatFence.ts).
 */

/** Files that hold secrets, as globs are matched against them: `/etc/shad*` names /etc/shadow. */
const SENSITIVE_FILES = [
  "/etc/shadow",
  "/etc/gshadow",
  "/etc/sudoers",
  "/etc/master.passwd",
  "/etc/security/opasswd",
  "/proc/self/environ",
  "/etc/kubernetes/admin.conf",
  "/etc/kubernetes/super-admin.conf",
  "/etc/rancher/k3s/k3s.yaml",
  "~/.ssh/id_rsa",
  "~/.ssh/id_ed25519",
  "~/.ssh/id_ecdsa",
  "~/.aws/credentials",
  "~/.kube/config",
  "~/.docker/config.json",
  "~/.netrc",
  "~/.pgpass",
  "~/.my.cnf",
  "~/.git-credentials",
  ".env",
];

/** `a//b`, `a/./b` and `a/x/../b` are a/b. A relative path that climbs above its start keeps its leading `..`. */
function normalizePath(norm: string): string {
  const absolute = norm.startsWith("/");
  const out: string[] = [];
  for (const part of norm.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else if (part !== ".." || !absolute) out.push(part);
  }
  return `${absolute ? "/" : ""}${out.join("/")}` || (absolute ? "/" : ".");
}

/** A glob that could name a file that holds secrets. */
function globReachesSensitiveFile(lower: string): boolean {
  if (!/[*?[]/.test(lower) || lower.length > 300) return false;
  let source = "";
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    // As in the shell, a wildcard at the start of a name does not match a leading dot.
    if ((ch === "*" || ch === "?" || ch === "[") && (i === 0 || lower[i - 1] === "/")) source += "(?!\\.)";
    if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else if (ch === "[" && lower.indexOf("]", i + 1) > i) {
      // A bracket is any one character here: wider than the shell, never narrower.
      source += "[^/]";
      i = lower.indexOf("]", i + 1);
    } else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A path from the root (or home) is matched whole. A relative one is matched against the end of a
  // path, as the directory it is read in is not known, when its last name has some letters of its own:
  // `shad*` may be /etc/shadow, but a bare `*` is any directory's listing.
  const anchored = lower.startsWith("/") || lower.startsWith("~/");
  const lastName = lower.slice(lower.lastIndexOf("/") + 1).replace(/\[[^\]]*\]|[*?]/g, "");
  if (!anchored && lastName.length < 2) return false;
  // eslint-disable-next-line security/detect-non-literal-regexp -- built from one bounded word with every metacharacter escaped
  const re = new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`);
  if (SENSITIVE_FILES.some((f) => re.test(f))) return true;
  // `/home/x/.ssh/id_*`: the part before a trailing wildcard already names a secret.
  const stem = lower.replace(/[*?]+$/, "");
  return !/[*?[]/.test(stem) && isSensitivePath(stem);
}

/** Whether a path names a file that may hold a secret. Paths only: the text is never read as a command. */
export function isSensitivePath(raw: string): boolean {
  const cleaned = raw.trim().replace(/^file:\/\//i, "");
  if (!cleaned || cleaned === "-") return false;
  // Windows backslashes become forward slashes, and //, /./ and /../ are folded, so one rule fits both.
  const norm = normalizePath(cleaned.replace(/\\/g, "/"));
  const lower = norm.toLowerCase();

  if (globReachesSensitiveFile(lower)) return true;

  // The environment of a process: every secret it was started with.
  // eslint-disable-next-line security/detect-unsafe-regex -- anchored at both ends, fixed words between the optional parts
  if (/^\/proc\/(?:self|thread-self|\d+)(?:\/task\/\d+)?\/environ$/.test(lower)) return true;
  // A Kubernetes control plane's admin credentials.
  if (/^\/etc\/kubernetes\/[^/]+\.conf$/.test(lower) || lower === "/etc/rancher/k3s/k3s.yaml") return true;

  // PowerShell env: drive
  if (/^env:/i.test(norm)) return true;

  // SSH private keys and config/auth files (a *.pub public key is not one)
  if (/(?:^|\/)\.ssh\/id_[^/\s]*$/i.test(lower) && !lower.endsWith(".pub")) return true;
  if (/(?:^|\/)\.ssh\/(?:authorized_keys|config|.*_(?:rsa|ed25519|ecdsa|dsa))$/i.test(lower)) return true;
  if (/(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i.test(lower)) return true;

  // Cloud, container, database and package manager credential stores
  if (/(?:^|\/)\.aws\/(?:credentials|config)$/i.test(lower)) return true;
  if (/(?:^|\/)\.kube\/config$/i.test(lower)) return true;
  if (/(?:^|\/)\.docker\/config\.json$/i.test(lower)) return true;
  if (/(?:^|\/)\.config\/gcloud\/application_default_credentials\.json$/i.test(lower)) return true;
  if (/(?:^|\/)(?:\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.pgpass|\.my\.cnf)$/i.test(lower)) return true;

  // .env and .env.* files (including globs like .env*)
  const baseName = lower.split("/").pop() ?? "";
  if (baseName === ".env" || baseName.startsWith(".env.") || baseName === ".env*") return true;

  // Private key, certificate and keystore extensions
  if (/\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i.test(lower)) return true;

  // Operating system authentication and privilege files
  return (
    lower === "/etc/shadow" ||
    lower === "/etc/gshadow" ||
    lower === "/etc/sudoers" ||
    lower === "/etc/master.passwd" ||
    lower === "/etc/security/opasswd" ||
    lower.startsWith("/etc/sudoers.d/") ||
    lower === "/etc/sudoers.d"
  );
}
