// Word-level alignment between the passage on screen (reference) and what the
// ASR committed (heard). Everything JEV is later asked about comes out of here:
// JEV only reads text, so the acoustics never reach it — the alignment is what
// decides WHICH words are even worth a question.

export function tokenize(text) {
  const out = [];
  const re = /[A-Za-z0-9’']+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ raw: m[0], norm: normalize(m[0]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

export function normalize(word) {
  return word.toLowerCase().replace(/[’']/g, "");
}

// Longest common subsequence over normalized words, then walk the backtrace
// into ops. Passages are a few hundred words at most, so the O(n·m) table is
// cheaper than being clever.
export function align(referenceText, heardText) {
  const ref = tokenize(referenceText);
  const heard = tokenize(heardText);
  const n = ref.length;
  const m = heard.length;

  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] =
        ref[i].norm === heard[j].norm
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ref[i].norm === heard[j].norm) {
      ops.push({ op: "match", refIndex: i, ref: ref[i], heard: heard[j] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ op: "gap", refIndex: i, ref: ref[i] });
      i++;
    } else {
      ops.push({ op: "extra", refIndex: i, heard: heard[j] });
      j++;
    }
  }
  while (i < n) ops.push({ op: "gap", refIndex: i, ref: ref[i] }), i++;
  while (j < m) ops.push({ op: "extra", refIndex: n, heard: heard[j] }), j++;

  return { ref, heard, ops, ...pair(ops) };
}

// A `gap` immediately next to an `extra` is one substitution, not a drop plus
// an insert — that pair is what becomes a JEV "same word?" question.
function pair(ops) {
  const substitutions = [];
  const missed = [];
  const inserted = [];
  const matched = [];
  const used = new Set();

  ops.forEach((op, k) => {
    if (used.has(k)) return;
    if (op.op === "match") return matched.push(op);
    if (op.op === "gap") {
      const near = [k - 1, k + 1].find(
        (t) => !used.has(t) && ops[t] && ops[t].op === "extra",
      );
      if (near !== undefined) {
        used.add(near);
        substitutions.push({ refIndex: op.refIndex, ref: op.ref, heard: ops[near].heard });
        return;
      }
      return missed.push(op);
    }
    if (op.op === "extra") inserted.push(op);
  });

  return { substitutions, missed, inserted, matched };
}
