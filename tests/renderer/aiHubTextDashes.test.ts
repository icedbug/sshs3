import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Text a person reads in the AI Hub uses a colon, a comma or two sentences where a dash would stand as
 * punctuation. This reads every string and every piece of JSX text under components/AiHub and fails for
 * a long dash, or for a hyphen with a space on each side between two words. A lone dash shown for an
 * empty value is fine, and so is arithmetic, which is not text.
 */
const ROOT = path.resolve(__dirname, '../../src/renderer/src/components/AiHub');

const LONG_DASH = /[‒–—―]/;
const SPACED_HYPHEN = /\w - \w/;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

interface Piece {
  line: number;
  text: string;
  /** A whole string or a whole piece of JSX text, not a part of a template between two values. */
  whole: boolean;
}

/** The text of every string, template piece and JSX text in a source, with the line it starts on. */
function texts(source: string, fileName = 'sample.tsx'): Piece[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Piece[] = [];
  const visit = (node: ts.Node): void => {
    const whole = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isJsxText(node);
    if (whole || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: (node as ts.LiteralLikeNode).text, whole });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** A dash that is all there is: what a cell shows when it has no value. */
const loneDash = ({ text, whole }: Piece): boolean => whole && /^[–—]$/.test(text.trim());

const dashes = (source: string, fileName?: string): string[] =>
  texts(source, fileName)
    .filter((piece) => (LONG_DASH.test(piece.text) && !loneDash(piece)) || SPACED_HYPHEN.test(piece.text))
    .map(({ line, text }) => `${line}: ${text.trim().slice(0, 100)}`);

describe('text in the AI Hub', () => {
  it('the check finds a dash used as punctuation, and leaves arithmetic and a lone dash alone', () => {
    expect(dashes('const a = <p>Low — fastest</p>;')).toHaveLength(1);
    expect(dashes('const a = "Saved - nothing was sent";')).toHaveLength(1);
    expect(dashes('const a = `${name} – ${role}`;')).toHaveLength(1);
    expect(dashes('const a = count - 1; const b = <td>{value ?? "—"}</td>; const c = "| - | - |";')).toEqual([]);
  });

  it('has no dash used as punctuation', () => {
    const files = sourceFiles(ROOT);
    expect(files.length).toBeGreaterThan(40);
    const found = files.flatMap((file) => dashes(fs.readFileSync(file, 'utf8'), file).map((hit) => `${path.relative(ROOT, file)}:${hit}`));
    expect(found).toEqual([]);
  });
});
