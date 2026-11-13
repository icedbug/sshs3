import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The product is English: its interface, what it says to a model, what it
 * writes into memory, and its comments. Earlier versions were partly Swedish,
 * and Swedish kept coming back at the edges. This keeps it out.
 *
 * A file may be listed below when it has to RECOGNISE Swedish (output of a
 * Swedish system, a Swedish search term) or names a Swedish key. The reason
 * is part of the entry.
 */
const ALLOWED: Record<string, string> = {
  "src/renderer/src/lib/sudoRetry.ts": "recognises 'permission denied' as localised systems print it",
  "src/main/smartcard/WindowsAgentPath.ts": "recognises the Swedish Windows message for a cancelled elevation",
  "src/renderer/src/lib/shortcuts.ts": "names the å, ä and ö keys of a Nordic keyboard",
  "src/main/storage/winAttributes.ts": "an example path with non-ASCII letters",
  "src/main/services/TeamVaultCryptoService.ts": "cites a section title of the team vault design",
  "src/main/services/AgePtyPinRelay.ts": "cites a section title of the team vault design",
  "src/main/ai/hub/KnowledgeBaseService.ts": "search synonyms: a team may write and ask in Swedish, and the tokenizer keeps å, ä, ö",
  "src/main/ai/hub/KbCompile.ts": "the tokenizer keeps å, ä, ö and ü",
  "src/main/ai/hub/KbLint.ts": "the same tokenizer, for the words of a page's title",
};

const LETTERS = /[åäöÅÄÖ]/;
// Swedish that has none of those letters. Whole words only, and only words that are not also English.
const WORDS = /\b(och|inte|eller|kunde|saknar|ogiltig|ogiltigt|sparad|sparat|kopierad|misslyckades|lyckades|uppdrag|anledning|tidigare|notering|kontrollerar|verifierad|verifierat|visar|kopplad|synka|kluster|felaktigt|vald|valda|klar|klart|avbryt|spara|redigera)\b/i;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("the language of the product", () => {
  it("is English in every source file, except where Swedish has to be recognised", () => {
    const root = path.resolve(__dirname, "../..");
    const found: string[] = [];
    for (const file of sources(path.join(root, "src"))) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (ALLOWED[rel]) continue;
      fs.readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (LETTERS.test(line) || WORDS.test(line)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
        });
    }
    // Shown in full when it fails, so the lines can be fixed (or the file listed above, with its reason).
    expect(found).toEqual([]);
  });

  it("lists only files that exist and still need the exception", () => {
    const root = path.resolve(__dirname, "../..");
    for (const rel of Object.keys(ALLOWED)) {
      const text = fs.readFileSync(path.join(root, rel), "utf8");
      expect(LETTERS.test(text) || WORDS.test(text), `${rel} no longer has anything to allow`).toBe(true);
    }
  });
});
