// What changed inside a segment between two versions of it, line by line.

export type LineChange = {
  /** The new text starts with the old one: only added to, which a prefix cache tolerates. */
  appendOnly: boolean;
  linesBefore: number;
  linesAfter: number;
  added: string[];
  removed: string[];
};

/** Lines compared as a multiset: a line moved within the segment doesn't count as changed. */
export function lineChange(before: string, after: string): LineChange {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const unmatched = new Map<string, number>();

  for (const line of oldLines) {
    unmatched.set(line, (unmatched.get(line) ?? 0) + 1);
  }

  const added: string[] = [];

  for (const line of newLines) {
    const left = unmatched.get(line) ?? 0;

    if (left > 0) {
      unmatched.set(line, left - 1);
    } else {
      added.push(line);
    }
  }

  const removed = [...unmatched].flatMap(([line, n]) => Array<string>(n).fill(line));

  return {
    appendOnly: after.startsWith(before),
    linesBefore: oldLines.length,
    linesAfter: newLines.length,
    added,
    removed,
  };
}

/** Share of lines, across both versions, that are added or removed. */
export function changedShare(change: LineChange): number {
  const total = change.linesBefore + change.linesAfter;

  return total === 0 ? 0 : (change.added.length + change.removed.length) / total;
}
