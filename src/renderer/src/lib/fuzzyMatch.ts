/**
 * Fuzzy subsequence matching for the global search, after the fzy algorithm: every query character
 * must appear in the text in order, and the score rewards a match at the start of a word, after a
 * separator, and in an unbroken run, and penalizes gaps. Pure and allocation-light enough to run on
 * every entry for every keystroke (texts are profile names and hosts, never long).
 */

export interface FuzzyMatch {
  /** Higher is better; only comparable between matches of the same query. 0 for an empty query. */
  score: number;
  /** Position of each matched character, in characters of the text (not UTF-16 units). */
  indices: number[];
}

/** Longer texts are not worth matching and would make the O(n·m) tables large. */
const MAX_TEXT_LENGTH = 256;

const SCORE_GAP_LEADING = -0.005;
const SCORE_GAP_TRAILING = -0.005;
const SCORE_GAP_INNER = -0.01;
const SCORE_MATCH_CONSECUTIVE = 1;
const SCORE_MATCH_SLASH = 0.9;
const SCORE_MATCH_WORD = 0.8;
const SCORE_MATCH_CAPITAL = 0.7;
const SCORE_MATCH_DOT = 0.6;

const fold = (s: string): string[] => Array.from(s, (ch) => ch.toLowerCase());

/** How good a match is at `index`, from the character before it. */
function boundaryBonus(chars: string[], index: number): number {
  if (index === 0) return SCORE_MATCH_SLASH;
  const prev = chars[index - 1];
  if (prev === '/' || prev === ':' || prev === '@') return SCORE_MATCH_SLASH;
  if (prev === '-' || prev === '_' || prev === ' ') return SCORE_MATCH_WORD;
  if (prev === '.') return SCORE_MATCH_DOT;
  const cur = chars[index];
  if (prev === prev.toLowerCase() && cur !== cur.toLowerCase() && prev !== prev.toUpperCase()) return SCORE_MATCH_CAPITAL;
  return 0;
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = fold(query);
  const original = Array.from(text);
  if (needle.length === 0) return { score: 0, indices: [] };
  if (original.length > MAX_TEXT_LENGTH || needle.length > original.length) return null;

  const hay = original.map((ch) => ch.toLowerCase());
  const n = needle.length;
  const m = hay.length;

  // Quick reject: is it a subsequence at all?
  let from = 0;
  for (const ch of needle) {
    const at = hay.indexOf(ch, from);
    if (at < 0) return null;
    from = at + 1;
  }

  const bonus = original.map((_, j) => boundaryBonus(original, j));
  // D[i][j]: best score with needle[i] matched at hay[j]; M[i][j]: best score using needle[0..i] within hay[0..j].
  const D: number[][] = [];
  const M: number[][] = [];
  for (let i = 0; i < n; i++) {
    D.push(new Array<number>(m).fill(-Infinity));
    M.push(new Array<number>(m).fill(-Infinity));
    let prevScore = -Infinity;
    const gap = i === n - 1 ? SCORE_GAP_TRAILING : SCORE_GAP_INNER;
    for (let j = 0; j < m; j++) {
      if (needle[i] === hay[j]) {
        let score = -Infinity;
        if (i === 0) {
          score = j * SCORE_GAP_LEADING + bonus[j];
        } else if (j > 0) {
          score = Math.max(M[i - 1][j - 1] + bonus[j], D[i - 1][j - 1] + SCORE_MATCH_CONSECUTIVE);
        }
        D[i][j] = score;
        prevScore = Math.max(score, prevScore + gap);
      } else {
        prevScore += gap;
      }
      M[i][j] = prevScore;
    }
  }

  const indices = new Array<number>(n);
  let matchRequired = false;
  for (let i = n - 1, j = m - 1; i >= 0; i--) {
    for (; j >= 0; j--) {
      if (D[i][j] !== -Infinity && (matchRequired || D[i][j] === M[i][j])) {
        matchRequired = i > 0 && j > 0 && M[i][j] === D[i - 1][j - 1] + SCORE_MATCH_CONSECUTIVE;
        indices[i] = j--;
        break;
      }
    }
  }
  return { score: M[n - 1][m - 1], indices };
}
