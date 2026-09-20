// Turns one reading into marks and a total.
//
// Who decides what:
//   JEV        — 每个可疑词「读的是同一个词吗」(noul)、错误属于哪一类 (choice)、
//                整段「听懂的是同一句话吗」(score 1–5)
//   对齐算术    — 漏读、多读、完整度
//   时间戳算术  — 语速与停顿
//   本机加权    — 总分
// 发音、重音、口音一律不出分：JEV 只读文本，判不了声学。

import { align } from "./align.js";
import { ask } from "./jev.js";

export const WEIGHTS = { correct: 0.45, complete: 0.25, pace: 0.15, meaning: 0.15 };
const DOUBT = 0.8; // noul 以下算存疑
const WRONG = 0.5; // noul 以下算读错
const MAX_QUESTIONS = 24; // 一次调用里塞的问题上限，超了分批

const ERROR_KINDS = {
  substitution: "读成了另一个词",
  asr_variant: "同一个词，只是 ASR 拼写不同",
  self_correction: "自己重复或当场纠正了",
};

export async function scoreReading({ reference, heard, durationMs = 0, pauses = 0 }) {
  const a = align(reference, heard);
  const state = `原文:\n${reference}\n\n听到（ASR 已提交的文本）:\n${heard}`;

  const suspects = a.substitutions.slice(0, Math.floor(MAX_QUESTIONS / 2));
  const questions = {};
  suspects.forEach((s, i) => {
    questions[`same_${i}`] = {
      type: "noul",
      instructions: `原文里的词是 “${s.ref.raw}”，这个位置 ASR 听到的是 “${s.heard.raw}”。朗读者念的就是原文那个词吗？只看文本：忽略大小写、连字符和 ASR 的拼写变体。`,
    };
    questions[`kind_${i}`] = {
      type: "choice",
      instructions: `“${s.ref.raw}” 被听成 “${s.heard.raw}” 属于哪一类`,
      criteria: ERROR_KINDS,
    };
  });
  questions.meaning = {
    type: "score",
    instructions: "只读这两段文本：听到的内容还是原文那句话的意思吗",
    criteria: [
      "完全听不出是这句话",
      "只剩零散的词对得上",
      "大意在，关键词丢了几个",
      "基本是同一句话，个别词不同",
      "就是同一句话",
    ],
  };

  const reply = await ask(state, questions);
  const answers = reply.answers || {};

  const verdicts = suspects.map((s, i) => {
    const p = numberOr(answers[`same_${i}`]?.noul, 0.5);
    const kind = answers[`kind_${i}`]?.choice || "substitution";
    const conf = numberOr(answers[`kind_${i}`]?.confidence, 0);
    const status = kind === "self_correction" ? "doubt" : p >= DOUBT ? "ok" : p >= WRONG ? "doubt" : "wrong";
    return {
      refIndex: s.refIndex,
      word: s.ref.raw,
      heard: s.heard.raw,
      same: p,
      kind,
      kindLabel: ERROR_KINDS[kind] || kind,
      kindConfidence: conf,
      status,
    };
  });

  // 每个原文词一个状态，界面直接按它划线
  const marks = a.ref.map((t, index) => ({ index, word: t.raw, status: "missed" }));
  a.matched.forEach((op) => {
    if (marks[op.refIndex]) marks[op.refIndex].status = "ok";
  });
  verdicts.forEach((v) => {
    if (!marks[v.refIndex]) return;
    marks[v.refIndex].status = v.status;
    marks[v.refIndex].heard = v.heard;
    marks[v.refIndex].same = v.same;
    marks[v.refIndex].kind = v.kind;
  });

  const total = a.ref.length || 1;
  const spoken = a.matched.length + verdicts.length;
  const okCount = marks.filter((m) => m.status === "ok").length;
  const doubtCount = marks.filter((m) => m.status === "doubt").length;

  const correct = pct((okCount + doubtCount * 0.5) / total);
  const complete = pct(spoken / total);
  const meaningScore = numberOr(answers.meaning?.score, 0) + 1; // 0–4 → 1–5
  const pace = paceScore({ words: spoken, durationMs, pauses });

  const overall = Math.round(
    WEIGHTS.correct * correct +
      WEIGHTS.complete * complete +
      WEIGHTS.pace * pace +
      WEIGHTS.meaning * ((meaningScore / 5) * 100),
  );

  return {
    overall,
    sub: {
      correct: Math.round(correct),
      complete: Math.round(complete),
      pace: Math.round(pace),
      meaning: Number(meaningScore.toFixed(1)),
    },
    marks,
    verdicts,
    missed: a.missed.map((op) => ({ refIndex: op.refIndex, word: op.ref.raw })),
    inserted: a.inserted.map((op) => op.heard.raw),
    wpm: wpm({ words: spoken, durationMs }),
    jev: { model: reply.model, usage: reply.usage, questions: Object.keys(questions).length },
  };
}

// 语速与停顿：纯算术，不问模型。150 wpm 附近满分，偏离每 10 wpm 扣 4 分，
// 每次超过 1.2s 的停顿扣 3 分。
export function paceScore({ words, durationMs, pauses = 0 }) {
  if (!durationMs || !words) return 70;
  const rate = wpm({ words, durationMs });
  const off = Math.abs(rate - 150);
  return clamp(100 - (off / 10) * 4 - pauses * 3, 0, 100);
}

export function wpm({ words, durationMs }) {
  if (!durationMs) return 0;
  return Math.round((words / (durationMs / 60000)) || 0);
}

function pct(x) {
  return clamp(x * 100, 0, 100);
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

function numberOr(x, fallback) {
  return typeof x === "number" && Number.isFinite(x) ? x : fallback;
}
