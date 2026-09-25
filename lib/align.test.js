import { test } from "node:test";
import assert from "node:assert/strict";
import { align, tokenize, normalize } from "./align.js";
import { mockCommits } from "./asr.js";
import { recordCommitTimestamp } from "./pauses.js";
import { paceScore, wpm } from "./score.js";

test("tokenize keeps offsets so the page can re-insert punctuation", () => {
  const t = tokenize("Liberty, and");
  assert.deepEqual(t.map((w) => w.raw), ["Liberty", "and"]);
  assert.equal("Liberty, and".slice(t[0].end, t[1].start), ", ");
});

test("normalize folds case and apostrophes", () => {
  assert.equal(normalize("’Tis"), "tis");
});

test("a swapped word is one substitution, not a drop plus an insert", () => {
  const a = align("dedicated to the proposition that all", "dedicated to the proposal that all");
  assert.equal(a.substitutions.length, 1);
  assert.equal(a.substitutions[0].ref.raw, "proposition");
  assert.equal(a.substitutions[0].heard.raw, "proposal");
  assert.equal(a.missed.length, 0);
  assert.equal(a.matched.length, 5);
});

test("a skipped tail counts as missed, not substituted", () => {
  const a = align("one two three four", "one two");
  assert.deepEqual(a.missed.map((m) => m.ref.raw), ["three", "four"]);
  assert.equal(a.substitutions.length, 0);
});

test("mock ASR commits a prefix that only grows, and drops the last sentence", () => {
  const text =
    "one two three four five six seven eight nine ten eleven twelve. Thirteen fourteen fifteen sixteen.";
  const { events, heard } = mockCommits(text);
  assert.ok(events.length > 0);
  assert.ok(events.every((e, i) => i === 0 || e.t >= events[i - 1].t));
  assert.ok(heard.includes("twelve"));
  assert.ok(!heard.includes("thirteen"), "最后一句该是漏读的");
});

test("pace is arithmetic: 150 wpm is the peak", () => {
  assert.equal(wpm({ words: 150, durationMs: 60000 }), 150);
  assert.equal(paceScore({ words: 150, durationMs: 60000 }), 100);
  assert.ok(paceScore({ words: 75, durationMs: 60000 }) < 80);
  assert.ok(paceScore({ words: 150, durationMs: 60000, pauses: 4 }) < 90);
});

test("browser commit timestamps count pauses over 1.2 seconds", () => {
  const stats = { lastCommitAt: null, pauses: 0 };
  [0, 1200, 2401, 3601, 4802].forEach((at) => recordCommitTimestamp(stats, at));
  recordCommitTimestamp(stats, Number.NaN);

  assert.equal(stats.pauses, 2);
  assert.equal(stats.lastCommitAt, 4802);
  assert.equal(paceScore({ words: 150, durationMs: 60000, pauses: stats.pauses }), 94);
});
