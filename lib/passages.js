// 三篇默认文稿，都在公有领域。
// 刻意都压到 25–35 词（读一遍 12–18 秒）：一来线上中继单次 30 秒就断，
// 二来短文稿才练得动 —— 读错的词当场重来，而不是从头再念一分钟。
export const PASSAGES = [
  {
    id: "gettysburg",
    title: "The Gettysburg Address",
    byline: "Lincoln · 1863 · 中级",
    text:
      "Four score and seven years ago our fathers brought forth on this continent a new nation, conceived in Liberty, and dedicated to the proposition that all men are created equal.",
  },
  {
    id: "inaugural",
    title: "Inaugural Address",
    byline: "Kennedy · 1961 · 进阶",
    text:
      "And so, my fellow Americans: ask not what your country can do for you — ask what you can do for your country.",
  },
  {
    id: "hamlet",
    title: "To be, or not to be",
    byline: "Hamlet · 独白 · 高难",
    text:
      "To be, or not to be, that is the question: whether 'tis nobler in the mind to suffer the slings and arrows of outrageous fortune.",
  },
];

export function getPassage(id) {
  return PASSAGES.find((p) => p.id === id) || PASSAGES[0];
}
