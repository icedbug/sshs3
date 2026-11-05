import { describe, it, expect } from 'vitest';
import {
  stripAnsiForPortDetection,
  isValidServicePort,
  validateCustomPortRegex,
  detectPortsInOutput,
} from '../../src/renderer/src/lib/portDetection';

describe('portDetection', () => {
  describe('stripAnsiForPortDetection', () => {
    it('strips ANSI color codes and control characters', () => {
      const colored = '\x1b[32m✔\x1b[39m \x1b[1mServer ready at:\x1b[22m http://localhost:\x1b[36m3000\x1b[39m\x00';
      const stripped = stripAnsiForPortDetection(colored);
      expect(stripped).toContain('http://localhost:3000');
    });
  });

  describe('isValidServicePort', () => {
    it('accepts typical service ports', () => {
      expect(isValidServicePort(80)).toBe(true);
      expect(isValidServicePort(443)).toBe(true);
      expect(isValidServicePort(3000)).toBe(true);
      expect(isValidServicePort(8080)).toBe(true);
      expect(isValidServicePort(5173)).toBe(true);
      expect(isValidServicePort(65535)).toBe(true);
    });

    it('rejects out of range or excluded system ports', () => {
      expect(isValidServicePort(0)).toBe(false);
      expect(isValidServicePort(-1)).toBe(false);
      expect(isValidServicePort(22)).toBe(false);
      expect(isValidServicePort(25)).toBe(false);
      expect(isValidServicePort(53)).toBe(false);
      expect(isValidServicePort(79)).toBe(false);
      expect(isValidServicePort(65536)).toBe(false);
      expect(isValidServicePort(70000)).toBe(false);
    });
  });

  describe('validateCustomPortRegex', () => {
    it('accepts empty or whitespace regex', () => {
      expect(validateCustomPortRegex('').valid).toBe(true);
      expect(validateCustomPortRegex('   ').valid).toBe(true);
    });

    it('accepts valid regex syntax', () => {
      expect(validateCustomPortRegex('port: (\\d+)').valid).toBe(true);
      expect(validateCustomPortRegex('ready at :(?<port>\\d{2,5})').valid).toBe(true);
    });

    it('rejects invalid regex syntax', () => {
      const res = validateCustomPortRegex('[unclosed group');
      expect(res.valid).toBe(false);
      expect(res.error).toBeDefined();
    });

    it('rejects nested quantifiers prone to catastrophic backtracking', () => {
      expect(validateCustomPortRegex('(a+)+$').valid).toBe(false);
    });

    it('rejects excessively long regex', () => {
      const longPattern = 'a'.repeat(301);
      const res = validateCustomPortRegex(longPattern);
      expect(res.valid).toBe(false);
      expect(res.error).toContain('too long');
    });
  });

  describe('detectPortsInOutput', () => {
    it('detects standard URLs with ports', () => {
      const output = 'Application running on http://localhost:8080 and https://127.0.0.1:8443';
      const results = detectPortsInOutput(output);
      expect(results).toHaveLength(2);
      expect(results[0].port).toBe(8080);
      expect(results[0].protocol).toBe('http');
      expect(results[1].port).toBe(8443);
      expect(results[1].protocol).toBe('https');
    });

    it('detects Vite dev server output', () => {
      const viteOutput = `
  VITE v5.2.0  ready in 120 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
      `;
      const results = detectPortsInOutput(viteOutput);
      expect(results).toHaveLength(1);
      expect(results[0].port).toBe(5173);
      expect(results[0].protocol).toBe('http');
    });

    it('detects Next.js dev server output', () => {
      const nextOutput = `
   ▲ Next.js 14.1.0
   - Local:        http://localhost:3000
   - Experiments (turbo):
      `;
      const results = detectPortsInOutput(nextOutput);
      expect(results).toHaveLength(1);
      expect(results[0].port).toBe(3000);
    });

    it('detects Python Flask server output', () => {
      const flaskOutput = ' * Running on http://127.0.0.1:5000 (Press CTRL+C to quit)';
      const results = detectPortsInOutput(flaskOutput);
      expect(results).toHaveLength(1);
      expect(results[0].port).toBe(5000);
    });

    it('detects Django development server output', () => {
      const djangoOutput = 'Starting development server at http://127.0.0.1:8000/\nQuit the server with CONTROL-C.';
      const results = detectPortsInOutput(djangoOutput);
      expect(results).toHaveLength(1);
      expect(results[0].port).toBe(8000);
    });

    it('detects Spring Boot Tomcat output', () => {
      const springOutput = '2026-10-18 09:00:00.000  INFO 1 --- [main] o.s.b.w.embedded.tomcat.TomcatWebServer  : Tomcat started on port(s): 8080 (http) with context path \'\'';
      const results = detectPortsInOutput(springOutput);
      expect(results).toHaveLength(1);
      expect(results[0].port).toBe(8080);
    });

    it('detects Python http.server output', () => {
      const pyHttpOutput = 'Serving HTTP on 0.0.0.0 port 8888 (http://0.0.0.0:8888/) ...';
      const results = detectPortsInOutput(pyHttpOutput);
      expect(results).toHaveLength(1);
      expect(results[0].port).toBe(8888);
    });

    it('detects Go Gin/Fiber listening output', () => {
      const goOutput = '[GIN-debug] Listening and serving HTTP on :9090';
      const results = detectPortsInOutput(goOutput);
      expect(results).toHaveLength(1);
      expect(results[0].port).toBe(9090);
    });

    it('handles ANSI colors in listening output', () => {
      const coloredOutput = '\x1b[32m[Nest]\x1b[39m 1234 - 10/18/2026 - \x1b[32mNest application successfully started\x1b[39m\nListening on port \x1b[33m4000\x1b[39m';
      const results = detectPortsInOutput(coloredOutput);
      expect(results).toHaveLength(1);
      expect(results[0].port).toBe(4000);
    });

    it('supports custom user-defined regexes', () => {
      const customOutput = '[MY-APP] Microservice bound to address 0.0.0.0 and port 7001';
      const customRegex = 'port (?<port>\\d+)';
      const results = detectPortsInOutput(customOutput, customRegex);
      expect(results).toHaveLength(1);
      expect(results[0].port).toBe(7001);
    });

    it('deduplicates identical ports within the same chunk', () => {
      const output = 'http://localhost:3000 and listening on port 3000';
      const results = detectPortsInOutput(output);
      expect(results).toHaveLength(1);
      expect(results[0].port).toBe(3000);
    });

    it('ignores numbers that merely follow a keyword or the word port', () => {
      expect(detectPortsInOutput('Running 120 tests')).toEqual([]);
      expect(detectPortsInOutput('ssh: connect to host x port 2222: refused')).toEqual([]);
      expect(detectPortsInOutput('Server listening on port 9000')[0]?.port).toBe(9000);
    });

    it('returns empty array when no port is found', () => {
      const output = 'total 32\ndrwxr-xr-x 2 user user 4096 Oct 18 09:00 src\n-rw-r--r-- 1 user user  123 Oct 18 09:00 package.json';
      const results = detectPortsInOutput(output);
      expect(results).toEqual([]);
    });
  });
});
