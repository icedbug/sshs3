import type {
  AgentMode,
  CommandRiskLevel,
  SafetyPolicyConfig,
} from "../../../shared/types/aiHub";

export interface CommandRiskAnalysis {
  riskLevel: CommandRiskLevel;
  riskReason: string;
  parsedSubcommands: string[];
}

export const DEFAULT_SAFETY_POLICY: SafetyPolicyConfig = {
  autoApproveSafeReadOnly: true,
  requireApprovalOnProdTags: true,
  blockDestructiveWithoutConfirm: true,
};

function stripLeadingSudoAndEnv(segment: string): string {
  let rest = segment.trim();
  while (rest) {
    if (/^sudo\s+/i.test(rest)) {
      rest = rest.replace(/^sudo\s+/i, "");
      while (/^-[a-zA-Z]+\s+/.test(rest)) {
        rest = rest.replace(/^-[a-zA-Z]+\s+/, "");
      }
      continue;
    }
    if (/^env\s+/i.test(rest)) {
      rest = rest.replace(/^env\s+/i, "");
      while (/^\S+=\S+\s+/.test(rest)) {
        rest = rest.replace(/^\S+=\S+\s+/, "");
      }
      continue;
    }
    break;
  }
  return rest;
}

/**
 * AST-style shell command splitter that breaks pipelines (`|`), logical chains (`&&`, `||`),
 * sequences (`;`, `\n`), extracts nested subshells (`$(...)`, `<(...)`, and backticks),
 * and unwraps nested shell invocations (`bash -c "..."`, `sh -c '...'`, `eval "..."`)
 * while respecting single and double quotes.
 */
export function splitShellAstSegments(command: string, depth = 0): string[] {
  const segments: string[] = [];
  const subshells: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const trimmed = (command ?? "").trim();
  if (!trimmed || depth > 4) return [];

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    const next = trimmed[i + 1];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && !inSingle) {
      current += ch;
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    // Extract $(...) and process substitution <(...) / >(...)
    if (
      !inSingle &&
      (ch === "$" || (!inDouble && (ch === "<" || ch === ">"))) &&
      next === "("
    ) {
      let parenDepth = 1;
      let j = i + 2;
      let inner = "";
      while (j < trimmed.length && parenDepth > 0) {
        if (trimmed[j] === "(" && trimmed[j - 1] !== "\\") parenDepth++;
        else if (trimmed[j] === ")" && trimmed[j - 1] !== "\\") parenDepth--;
        if (parenDepth > 0) inner += trimmed[j];
        j++;
      }
      if (inner.trim()) {
        subshells.push(inner.trim());
      }
      current += trimmed.slice(i, j);
      i = j - 1;
      continue;
    }

    // Extract backtick `...` subshells
    if (!inSingle && ch === "`") {
      let j = i + 1;
      let inner = "";
      while (j < trimmed.length && trimmed[j] !== "`") {
        inner += trimmed[j];
        j++;
      }
      if (inner.trim()) {
        subshells.push(inner.trim());
      }
      current += trimmed.slice(i, j + 1);
      i = j;
      continue;
    }

    if (!inSingle && !inDouble) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        if (current.trim()) segments.push(current.trim());
        current = "";
        i++;
        continue;
      }
      if (ch === ";" || ch === "|" || ch === "\n") {
        if (current.trim()) segments.push(current.trim());
        current = "";
        continue;
      }
    }

    current += ch;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  // Unwrap nested `bash -c "..."`, `sh -c '...'`, `zsh -c`, or `eval "..."`
  for (const seg of [...segments]) {
    const strippedSeg = stripLeadingSudoAndEnv(seg);
    const shellDashC =
      /^(?:bash|sh|zsh|dash|ksh)\s+-[a-zA-Z]*c\s+(['"])([\s\S]+)\1$/i.exec(
        strippedSeg,
      ) ?? /^eval\s+(['"])([\s\S]+)\1$/i.exec(strippedSeg);
    if (shellDashC?.[2]?.trim()) {
      subshells.push(shellDashC[2].trim());
    }
  }

  for (const sub of subshells) {
    for (const child of splitShellAstSegments(sub, depth + 1)) {
      if (!segments.includes(child)) {
        segments.push(child);
      }
    }
  }

  return segments;
}

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--recursive|--force|-rf|-fr)\b/i,
    reason: "Recursive/forced file deletion (rm -rf)",
  },
  {
    pattern: /\bfind\b.*\s-delete\b/i,
    reason: "Bulk file deletion via find -delete",
  },
  {
    pattern: /\bxargs\b.*\brm\b/i,
    reason: "Piped deletion via xargs rm",
  },
  {
    pattern: /\b(mkfs\.[a-z0-9]+|mkfs|wipefs|fdisk|parted|sfdisk|gdisk)\b/i,
    reason: "Disk formatting or partition table modification",
  },
  {
    pattern: /\bdd\s+.*\bof=\/dev\//i,
    reason: "Direct raw block device write (dd of=/dev/...)",
  },
  {
    pattern: /\b(zpool\s+destroy|zfs\s+destroy)\b/i,
    reason: "ZFS pool or dataset destruction",
  },
  {
    pattern: /\bceph\s+(osd\s+(purge|destroy)|mon\s+remove|fs\s+rm)\b/i,
    reason: "Destructive Ceph cluster OSD/Monitor removal",
  },
  {
    pattern: /\b(volume\s+delete|aggr\s+delete|lun\s+delete|vserver\s+delete)\b/i,
    reason: "NetApp ONTAP volume/aggregate/LUN deletion",
  },
  {
    pattern: /\bkubectl\s+delete\s+(namespace|ns|node|pv|pvc|crd|all)\b/i,
    reason: "Kubernetes cluster-critical resource deletion",
  },
  {
    pattern: /\b(shutdown|reboot|poweroff|halt|init\s+[06])\b/i,
    reason: "System power/reboot operation",
  },
  {
    pattern: /\b(iptables\s+-F|nft\s+flush\s+ruleset|ufw\s+reset)\b/i,
    reason: "Firewall ruleset flush",
  },
  {
    pattern: /\b(chmod\s+-R|chmod)\s+777\s+\/(etc|var|usr|boot|root)?\s*$/i,
    reason: "Unsafe recursive permission change on system root",
  },
];

const MODIFY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern:
      /\bsystemctl\s+(restart|stop|start|reload|enable|disable|mask|unmask|daemon-reload)\b/i,
    reason: "Systemd service state modification",
  },
  {
    pattern: /\bservice\s+\S+\s+(restart|stop|start|reload)\b/i,
    reason: "Service state modification",
  },
  {
    pattern:
      /\b(apt|apt-get|dnf|yum|zypper|apk|pacman)\s+(install|remove|purge|upgrade|dist-upgrade|autoremove|update)\b/i,
    reason: "Package manager operation",
  },
  {
    pattern:
      /\bkubectl\s+(apply|create|patch|replace|scale|rollout|cordon|uncordon|drain|taint|label|annotate|delete|edit)\b/i,
    reason: "Kubernetes workload/cluster state change",
  },
  {
    pattern: /\bhelm\s+(install|upgrade|uninstall|rollback)\b/i,
    reason: "Helm release mutation",
  },
  {
    pattern:
      /\b(docker|podman|nerdctl)\s+(rm|stop|kill|restart|run|exec|compose\s+up|compose\s+down)\b/i,
    reason: "Container lifecycle mutation",
  },
  {
    pattern:
      /\b(snapmirror\s+(resync|update|break|abort|initialize|quiesce|resume)|volume\s+(modify|create|move|autosize)|qos\s+policy-group\s+(create|modify|delete))\b/i,
    reason: "NetApp ONTAP storage configuration change",
  },
  {
    pattern:
      /\b(ceph\s+osd\s+(out|in|reweight|set|unset)|zpool\s+(scrub|add|attach|detach|replace|set)|zfs\s+set)\b/i,
    reason: "Ceph / ZFS storage pool state change",
  },
  {
    pattern:
      /\b(sed\s+-i|tee\s+|cp\s+|mv\s+|rm\s+|mkdir\s+|touch\s+|chmod\s+|chown\s+|ln\s+|useradd\s+|usermod\s+|sysctl\s+-w)\b/i,
    reason: "Filesystem or OS configuration mutation",
  },
  {
    pattern: /(?:^|[^2>])>>?\s*(?!\/dev\/null\b)\S+/,
    reason: "File output redirection (> or >>)",
  },
];

const SAFE_READONLY_PATTERNS: RegExp[] = [
  /^(?:sudo\s+|)(ls|df|du|free|uptime|uname|whoami|id|hostname|date|pwd|env|printenv|lscpu|lsblk|lspci|lsusb|lsof|stat|file|wc|head|tail|cat|less|more|grep|egrep|fgrep|awk|cut|sort|uniq|tr|jq|yq|md5sum|sha256sum)\b/i,
  /^(?:sudo\s+|)(ps|top\s+-b|vmstat|iostat|mpstat|sar|pidstat|numastat)\b/i,
  /^(?:sudo\s+|)systemctl\s+(status|is-active|is-enabled|list-units|list-unit-files|show|--failed)\b/i,
  /^(?:sudo\s+|)(journalctl|dmesg)\b/i,
  /^(?:sudo\s+|)(ip\s+(?:-[a-zA-Z0-9]+\s+|)(?:-[a-zA-Z0-9]+\s+|)(addr|a|route|r|link|neigh|rule)|ss|netstat|ping\s+-c|traceroute|tracepath|mtr\s+-r|dig|nslookup|host|ethtool|multipath\s+-ll|iscsiadm\s+-m\s+session)\b/i,
  /^(?:sudo\s+|)kubectl\s+(get|describe|logs|top|events|explain|version|cluster-info|api-resources|auth\s+can-i)\b/i,
  /^(?:sudo\s+|)(ceph\s+(status|-s|health|osd\s+(tree|df|stat|perf|pool\s+stats)|pg\s+stat|df|mon\s+stat|quorum_status)|zpool\s+(status|list|iostat|history)|zfs\s+(list|get))\b/i,
  /^(snapmirror\s+show|volume\s+show|aggr\s+show|storage\s+(failover|aggregate|disk)\s+show|network\s+interface\s+show|qos\s+statistics\s+.*show|system\s+node\s+show|lun\s+show|vserver\s+show|version)\b/i,
  /^(?:sudo\s+|)find\b(?![^;|]*\s(-delete|-exec\s+rm))\b/i,
  // Things that print or test and nothing else (writing somewhere is caught as a redirection before this).
  /^(echo|printf|true|test|\[)(\s|$)/,
  // Health and configuration checks of common services.
  /^(?:sudo\s+|)(pg_isready|mysqladmin\s+(ping|status|version))\b/i,
  /^(?:sudo\s+|)(nginx\s+-[tTvV]|apachectl\s+(-t|configtest)|apache2ctl\s+(-t|configtest)|sshd\s+-[tT]|haproxy\s+-c\b|named-checkconf|visudo\s+-c)\b/i,
  /^(?:sudo\s+|)(docker|podman)\s+(ps|images|inspect|logs|version|info|top|port|diff|history|stats\s+--no-stream|network\s+(ls|inspect)|volume\s+(ls|inspect)|compose\s+(ps|logs|config|images|top))\b/i,
  /^(?:sudo\s+|)openssl\s+(x509|verify|version|s_client)\b(?!.*\s-out\b)/i,
  // Asking the package manager what is installed. Only the query forms: rpm -q…, never -i/-U/-e.
  /^(?:sudo\s+|)(dpkg-query\s+(-W|-l|-s|-L|--show|--list|--status)|dpkg\s+(-l|-s|-L|--list|--status)|rpm\s+-q[a-zA-Z]*|apk\s+(info|list|version)|apt\s+list|apt-cache\s+(policy|show|search)|pip3?\s+(list|show|freeze)|snap\s+list)\b/i,
  // Asking whether a program exists.
  /^(command\s+-v|which|type)\s+[\w.+-]+$/,
];

/** Words of a command segment, quotes removed. Good enough to read flags; not a shell parser. */
function words(seg: string): string[] {
  return (seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^(['"])(.*)\1$/, "$2"));
}

const CURL_SENDS = /^(-d|--data.*|--json|-F|--form.*|-T|--upload-file|-K|--config|-O|--remote-name.*|-c|--cookie-jar|--create-dirs|-J|--remote-header-name)$/;

/**
 * A curl that only asks: no body, no upload, no file written (output to
 * /dev/null or to the terminal), and GET or HEAD. This is what a health check
 * looks like, and it is the commonest thing an investigation needs.
 */
function isReadOnlyCurl(seg: string): boolean {
  const w = words(seg.replace(/^sudo\s+/, ""));
  if (w[0] !== "curl") return false;
  for (let i = 1; i < w.length; i++) {
    const flag = w[i];
    if (CURL_SENDS.test(flag)) return false;
    // Combined short flags: -sSfo, -XPOST.
    if (/^-[a-zA-Z]{2,}$/.test(flag) && /[dFTKOcJ]/.test(flag.slice(1).replace(/[oX].*$/, ""))) return false;
    const method = flag === "-X" || flag === "--request" ? w[i + 1] : /^-X(.+)$/.exec(flag)?.[1] ?? /^--request=(.+)$/.exec(flag)?.[1];
    if (method && !/^(GET|HEAD)$/i.test(method)) return false;
    const out =
      flag === "-o" || flag === "--output"
        ? w[i + 1]
        : /^--output=(.+)$/.exec(flag)?.[1] ?? (/^-[a-zA-Z]*o$/.test(flag) ? w[i + 1] : undefined);
    if (out !== undefined && out !== "/dev/null" && out !== "-") return false;
  }
  return true;
}

/** A wget that fetches to the terminal or to nowhere. */
function isReadOnlyWget(seg: string): boolean {
  const w = words(seg.replace(/^sudo\s+/, ""));
  if (w[0] !== "wget") return false;
  if (w.some((x) => /^--(post-|method=(?!GET|HEAD)|body-|input-file|mirror|recursive)/i.test(x))) return false;
  return w.includes("--spider") || /(^|\s)-[a-zA-Z]*O\s*(-|\/dev\/null)(\s|$)/.test(seg);
}

/** redis-cli asking how the server is: ping, info or dbsize after connection options, and nothing else. */
function isReadOnlyRedis(seg: string): boolean {
  const w = words(seg.replace(/^sudo\s+/, ""));
  if (w[0] !== "redis-cli") return false;
  let i = 1;
  while (i < w.length && /^-[hpna]$/.test(w[i])) i += 2;
  const rest = w.slice(i).map((x) => x.toLowerCase());
  return (rest.length === 1 && ["ping", "dbsize", "info"].includes(rest[0])) || (rest.length === 2 && rest[0] === "info");
}

/** Read-only forms that need more than a pattern on the first word. */
const SAFE_READONLY_CHECKS: Array<(seg: string) => boolean> = [isReadOnlyCurl, isReadOnlyWget, isReadOnlyRedis];

export function analyzeCommandSafety(command: string): CommandRiskAnalysis {
  const segments = splitShellAstSegments(command);
  if (segments.length === 0) {
    return {
      riskLevel: "safe",
      riskReason: "Empty command",
      parsedSubcommands: [],
    };
  }

  let highestLevel: CommandRiskLevel = "safe";
  const reasons: string[] = [];

  for (const seg of segments) {
    let segMatchedDestructive = false;
    for (const rule of DESTRUCTIVE_PATTERNS) {
      if (rule.pattern.test(seg)) {
        highestLevel = "destructive";
        if (!reasons.includes(rule.reason)) reasons.push(rule.reason);
        segMatchedDestructive = true;
      }
    }
    if (segMatchedDestructive) continue;

    let segMatchedModify = false;
    for (const rule of MODIFY_PATTERNS) {
      if (rule.pattern.test(seg)) {
        if (highestLevel !== "destructive") highestLevel = "modify";
        if (!reasons.includes(rule.reason)) reasons.push(rule.reason);
        segMatchedModify = true;
      }
    }
    if (segMatchedModify) continue;

    const isExplicitlySafe =
      SAFE_READONLY_PATTERNS.some((re) => re.test(seg)) || SAFE_READONLY_CHECKS.some((check) => check(seg));
    if (!isExplicitlySafe) {
      if (highestLevel === "safe") {
        highestLevel = "modify";
      }
      const cmdVerb = seg.split(/\s+/)[0] || seg;
      const msg = `Unverified command (${cmdVerb})`;
      if (!reasons.includes(msg)) reasons.push(msg);
    }
  }

  if (highestLevel === "safe" && reasons.length === 0) {
    reasons.push("Verified read-only diagnostic command (AST checked)");
  }

  return {
    riskLevel: highestLevel,
    riskReason: reasons.join(" · "),
    parsedSubcommands: segments,
  };
}

export function shouldRequireCommandApproval(opts: {
  analysis: CommandRiskAnalysis;
  mode: AgentMode;
  targetTags?: string[];
  policy?: SafetyPolicyConfig;
}): boolean {
  const policy = opts.policy ?? DEFAULT_SAFETY_POLICY;
  const tags = (opts.targetTags ?? []).map((t) => t.toLowerCase());
  const isProdTarget = tags.some(
    (t) => t === "prod" || t === "production" || t === "critical",
  );

  if (opts.mode === "advice") {
    return true;
  }

  if (
    opts.analysis.riskLevel === "destructive" &&
    policy.blockDestructiveWithoutConfirm
  ) {
    return true;
  }

  if (opts.mode === "autonomous") {
    if (
      opts.analysis.riskLevel !== "safe" &&
      policy.requireApprovalOnProdTags &&
      isProdTarget
    ) {
      return true;
    }
    return false;
  }

  // Assisted mode: auto-approve verified read-only commands when autoApproveSafeReadOnly is enabled
  if (
    opts.analysis.riskLevel === "safe" &&
    policy.autoApproveSafeReadOnly
  ) {
    return false;
  }

  return true;
}
