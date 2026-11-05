/**
 * Port detection engine for terminal outputs.
 * Parses stdout/stderr chunks from PTY to detect listening web servers and services.
 */

/** Strips ANSI escape sequences and control characters from terminal text. */
export function stripAnsiForPortDetection(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, ' ');
}

export interface PortDetectionResult {
  port: number;
  protocol: 'http' | 'https';
  matchedText: string;
}

/** Built-in regexes covering standard URLs and common framework listening logs. */
const BUILT_IN_PORT_REGEXES: RegExp[] = [
  // Explicit http/https URL with host & port (e.g. http://localhost:3000, https://127.0.0.1:8443, http://0.0.0.0:5000)
  /(https?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|::1):(\d{2,5})/gi,

  // Common framework "Listening on / Server started on :3000" logs. The port must follow a host or ':'.
  /(?:listening|running|started|serving|bound|ready)\s+(?:at|on)\s+(?:(https?):\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|::)?:(\d{2,5})\b/gi,

  // Vite: Local: http://localhost:5173/
  /Local:\s+(https?):\/\/localhost:(\d{2,5})/gi,

  // Spring Boot / Tomcat: Tomcat started on port(s): 8080 (http)
  /Tomcat started on port\(s\):\s*(\d{2,5})\s*(?:\((https?)\))?/gi,

  // Python http.server: Serving HTTP on 0.0.0.0 port 8000
  /Serving\s+(HTTPS?|HTTP)\s+on\s+[\d.:]+\s+port\s+(\d{2,5})/gi,

  // Go / Gin / Fiber: Listening and serving HTTP on :8080
  /Listening and serving\s+(https?|HTTP)?\s+on\s+:(\d{2,5})/gi,

  // "Listening on port 3000", "Server running at port 8080": the port must follow a listening indicator
  /(?:listening|running|started|serving|bound|ready)\b[^\n]{0,40}?\bport\s*[:=]?\s*(\d{2,5})\b/gi,
];

/** Validates whether a port number is acceptable for a user-facing service. */
export function isValidServicePort(port: number): boolean {
  if (!Number.isInteger(port)) return false;
  // Ports below 80 are low system control ports; ports above 65535 are invalid
  if (port < 80 || port > 65535) return false;
  // Exclude common standard system ports that are rarely user web servers
  if (port === 22 || port === 25 || port === 53 || port === 110 || port === 143) return false;
  return true;
}

/** Validates a custom regular expression string provided by user in settings. */
export function validateCustomPortRegex(pattern: string): { valid: boolean; error?: string } {
  if (!pattern || !pattern.trim()) {
    return { valid: true };
  }
  const trimmed = pattern.trim();
  if (trimmed.length > 300) {
    return { valid: false, error: 'Regular expression is too long (maximum 300 characters).' };
  }
  try {
    const reg = new RegExp(trimmed);
    // Nested quantifiers such as (a+)+ or (.*)* are the classic catastrophic-backtracking shape.
    // Match the group body without overlapping quantifiers, then check it for +/* (linear, no ReDoS).
    const quantifiedGroup = /\(([^()]*)\)[+*{]/g;
    let group: RegExpExecArray | null;
    let nested = false;
    while ((group = quantifiedGroup.exec(trimmed)) !== null) {
      if (/[+*]/.test(group[1])) {
        nested = true;
        break;
      }
    }
    if (nested) {
      return { valid: false, error: 'Regular expression is too complex or susceptible to backtracking.' };
    }
    // Check if regex can execute safely on a test string without catastrophic backtracking
    const start = performance.now();
    reg.test('test string with port 8080');
    if (performance.now() - start > 100) {
      return { valid: false, error: 'Regular expression is too complex or susceptible to backtracking.' };
    }
    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: err?.message || 'Invalid regular expression syntax.' };
  }
}

/**
 * Scans a chunk of terminal output for listening web ports.
 * Returns unique detected ports with protocol ('http' or 'https').
 */
export function detectPortsInOutput(chunk: string, customRegex?: string): PortDetectionResult[] {
  if (!chunk || typeof chunk !== 'string') return [];

  // Limit chunk length to prevent ReDoS on massive output dumps
  const cleanChunk = stripAnsiForPortDetection(chunk.slice(-4000));
  const results: PortDetectionResult[] = [];
  const seenPorts = new Set<number>();

  const addPort = (portNum: number, protoCandidate: string | undefined, matched: string) => {
    if (!isValidServicePort(portNum)) return;
    if (seenPorts.has(portNum)) return;
    seenPorts.add(portNum);

    const protocol: 'http' | 'https' =
      protoCandidate?.toLowerCase() === 'https' || portNum === 443 || portNum === 8443 ? 'https' : 'http';

    results.push({
      port: portNum,
      protocol,
      matchedText: matched.trim(),
    });
  };

  // 1. Evaluate custom regex if valid and configured
  if (customRegex && customRegex.trim()) {
    try {
      const reg = new RegExp(customRegex.trim(), 'gi');
      let match: RegExpExecArray | null;
      let limit = 0;
      while ((match = reg.exec(cleanChunk)) !== null && limit++ < 10) {
        // Look for named group 'port', or first capture group, or digits in match
        const portStr = match.groups?.port || match[1] || match[0];
        const num = parseInt(portStr.replace(/\D/g, ''), 10);
        if (!Number.isNaN(num)) {
          addPort(num, match.groups?.protocol || match[2], match[0]);
        }
      }
    } catch {
      // Ignore invalid custom regex runtime errors
    }
  }

  // 2. Evaluate built-in regexes
  for (const regex of BUILT_IN_PORT_REGEXES) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    let limit = 0;
    while ((match = regex.exec(cleanChunk)) !== null && limit++ < 10) {
      // Different regexes have capture groups in different order
      let portCandidate: number | null = null;
      let protoCandidate: string | undefined = undefined;

      for (let i = 1; i < match.length; i++) {
        const val = match[i];
        if (!val) continue;
        if (/^\d{2,5}$/.test(val)) {
          portCandidate = parseInt(val, 10);
        } else if (/^https?$/i.test(val)) {
          protoCandidate = val;
        }
      }

      if (portCandidate !== null) {
        addPort(portCandidate, protoCandidate, match[0]);
      }
    }
  }

  return results;
}
