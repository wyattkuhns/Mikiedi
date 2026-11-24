/**
 * Line diff for the Mikiedi version panel (git/PR-style +/− rendering).
 *
 * Classic LCS dynamic programming over whole lines — memory pages are
 * hundreds of lines, not millions, so the O(n·m) table is fine and keeps
 * the plugin dependency-free. Output is structured hunks: context, del
 * (−, from side A), add (+, from side B), with configurable context radius.
 */

export interface DiffLine {
  type: "context" | "del" | "add";
  /** 1-based line number in side A (del/context). */
  a?: number;
  /** 1-based line number in side B (add/context). */
  b?: number;
  text: string;
}

export interface DiffHunk {
  /** 1-based line where the hunk starts on side A. */
  aStart: number;
  /** 1-based line where the hunk starts on side B. */
  bStart: number;
  lines: DiffLine[];
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  return text.split("\n");
}

/** LCS-backed op list over whole lines. */
function lineOps(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "context", a: i + 1, b: j + 1, text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", a: i + 1, text: a[i] });
      i++;
    } else {
      out.push({ type: "add", b: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", a: ++i, text: a[i - 1] });
  while (j < m) out.push({ type: "add", b: ++j, text: b[j - 1] });
  return out;
}

/**
 * Diff two full page contents into hunks. `context` = unchanged lines kept
 * around each change block (git default is 3). Tombstone sides (deleted
 * page) are treated as empty content.
 */
export function diffContents(aText: string, bText: string, context = 3): DiffHunk[] {
  const ops = lineOps(splitLines(aText), splitLines(bText));
  const hasChange = ops.some((o) => o.type !== "context");
  if (!hasChange) return [];

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let tailCtx: DiffLine[] = []; // context lines since the last change (unattached)
  let lastA = 0; // last a-side line number emitted (for add-only hunk starts)
  let lastB = 0;

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    hunks.push({
      aStart: first.a ?? lastA + 1,
      bStart: first.b ?? lastB + 1,
      lines: current,
    });
    for (const l of current) {
      if (l.a !== undefined) lastA = l.a;
      if (l.b !== undefined) lastB = l.b;
    }
    current = [];
  };

  for (const op of ops) {
    if (op.type === "context") {
      tailCtx.push(op);
      // Once the unattached tail exceeds what any future hunk could merge
      // (2*context) or lead with (context), the excess can be dropped.
      if (tailCtx.length > context * 2 + 1) tailCtx.shift();
      continue;
    }
    // A change: close the previous hunk if the gap is too large to merge.
    if (current.length > 0 && tailCtx.length > context * 2) {
      flush();
    }
    if (current.length === 0) {
      // Leading context: at most `context` lines immediately before.
      current.push(...tailCtx.slice(Math.max(0, tailCtx.length - context)));
    } else {
      current.push(...tailCtx);
    }
    tailCtx = [];
    current.push(op);
  }
  if (current.length > 0) {
    current.push(...tailCtx.slice(Math.max(0, tailCtx.length - context)));
  }
  flush();
  return hunks;
}

/** Convenience: are the two contents line-identical? */
export function identical(aText: string, bText: string): boolean {
  return aText === bText;
}
