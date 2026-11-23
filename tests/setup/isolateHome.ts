import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/**
 * Every test file gets a home folder of its own, made before the file runs and removed after it.
 *
 * Code that has no folder given to it falls back to the person's home: the AI settings in
 * `~/.sshs3/ai-config.json`, the managed block in `~/.ssh/config`, the `oc` shim in `~/.sshs3/bin`.
 * Tests that reached those wrote into the real home of whoever ran them, and read what an earlier
 * test had left there: one test switched the assistant on in the shared file, and another, which
 * expects it off, failed on every run after that. With a home per file neither can happen.
 */
const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
// Under the run's own folder (homeRoot.ts), which is removed whole when the run ends.
const home = fs.mkdtempSync(path.join(process.env.SSHS3_TEST_HOME_ROOT ?? os.tmpdir(), "home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const remove = (): void => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });

afterAll(() => {
  if (before.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = before.HOME;
  if (before.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = before.USERPROFILE;
  remove();
});
