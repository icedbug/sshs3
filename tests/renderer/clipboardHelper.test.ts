// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { writeClipboardText } from "../../src/renderer/src/lib/clipboard";

const real = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  if (real) Object.defineProperty(navigator, "clipboard", real);
  else delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  delete (document as unknown as { execCommand?: unknown }).execCommand;
});

describe("copying text", () => {
  it("works on a page served over plain http, where the browser gives pages no clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const execCommand = vi.fn(() => true);
    (document as unknown as { execCommand: unknown }).execCommand = execCommand;
    await expect(writeClipboardText("ssh-ed25519 AAAA")).resolves.toBeUndefined();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("says so when the text could not be copied at all", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    (document as unknown as { execCommand: unknown }).execCommand = vi.fn(() => false);
    await expect(writeClipboardText("x")).rejects.toThrow("Could not copy to the clipboard.");
  });

  it("is the only way the app writes to the clipboard", () => {
    const direct: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !name.includes(".test.") && !path.endsWith(join("lib", "clipboard.ts"))) {
          if (/navigator\.clipboard\??\s*\.writeText/.test(readFileSync(path, "utf8").replace(/\s+/g, " "))) direct.push(path);
        }
      }
    };
    walk(join(__dirname, "../../src/renderer/src"));
    expect(direct).toEqual([]);
  });
});
