import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * One folder per test run that holds every test file's home (see isolateHome.ts), removed when the
 * run ends. A worker that is stopped, or a file whose tests are all skipped, cleans up nothing
 * itself: this takes what is left.
 */
export default function setup(): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sshs3-test-homes-"));
  process.env.SSHS3_TEST_HOME_ROOT = root;
  return () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
