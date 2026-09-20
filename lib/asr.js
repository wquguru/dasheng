// ASR 侧：两个 provider，事件形状一样，页面不用改。
//
// mock  — 按 160ms 步长的节奏一个个「提交」词，只增不改（模拟 stable prefix），
//         并故意制造三类真实错误：ASR 拼写变体、读成另一个词、整句漏读。
//         不需要音频，用来把对齐 + JEV 那条链路跑通。
// r2t2  — 真接口：16k 单声道 PCM16 通过 WebSocket 送给 R2T2，收回它自己的
//         已提交前缀（msg.text）与未定稿尾巴（msg.partial）。
//         线上 demo 的中继就能用，见 R2T2_WS_URL。

const LOOKALIKE = {
  proposition: "proposal",
  dedicated: "dedicate",
  outrageous: "outrages",
  together: "to gather",
  freedom: "free doom",
  americans: "american",
  question: "quest shown",
  nobler: "no blur",
  continent: "contingent",
};

export function asrProvider() {
  return (process.env.ASR_PROVIDER || "mock").trim().toLowerCase();
}

// 把一段参考文本变成一串「已提交」的词 —— 带着 mock 的错误。
export function mockCommits(reference, { chunkMs = 160 } = {}) {
  const words = reference.match(/[^\s]+/g) || [];
  // 最后一句整句不读，制造漏读
  const tailStart = lastSentenceStart(words);
  const events = [];
  let t = 0;
  let substituted = false;

  words.forEach((raw, i) => {
    if (i >= tailStart) return;
    const bare = raw.replace(/[^A-Za-z0-9’']/g, "");
    const key = bare.toLowerCase();
    let heard = bare;
    let pause = 0;

    if (!substituted && LOOKALIKE[key]) {
      heard = LOOKALIKE[key];
      substituted = true;
      pause = chunkMs * 8; // 卡住的那一下
    } else if (/y$/i.test(bare) && bare.length > 5) {
      heard = bare.replace(/y$/i, "i"); // ASR 拼写变体：Liberty → liberti
    } else if (key === "and" && i > 6 && events.length) {
      events.push({ type: "word", text: heard.toLowerCase(), t }); // 自我重复
      t += chunkMs * 2;
    }

    t += chunkMs * Math.max(2, Math.ceil(bare.length / 2)) + pause;
    events.push({ type: "word", text: heard.toLowerCase(), t, pause: pause > 0 });
  });

  return {
    events,
    durationMs: t,
    pauses: events.filter((e) => e.pause).length,
    heard: events.map((e) => e.text).join(" "),
  };
}

// 最后一个句号之后的词一律不读 —— 漏读那条路必须每次都能演到
function lastSentenceStart(words) {
  for (let i = words.length - 2; i > words.length * 0.4; i--) {
    if (/[.!?][”"']?$/.test(words[i])) return i + 1;
  }
  return words.length;
}

// ---- 真接口 ----------------------------------------------------------------
//
// 两种方言、一份协议实现，见 lib/r2t2-protocol.js。
// 服务端这条路只在没有浏览器时用（脚本、批量评测）；页面走 lib/mic.js 直连。

import {
  ASR_EOS,
  CHUNK_MS,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  TAIL_SILENCE_MS,
  buildHeader,
  detectDialect,
  encodeFrame,
  normalizeHeard,
  readReply,
} from "./r2t2-protocol.js";

export function r2t2Config() {
  const url = process.env.R2T2_WS_URL || "";
  const dialect = (process.env.R2T2_DIALECT || detectDialect(url)).trim().toLowerCase();
  const capped = Number(process.env.R2T2_MAX_SECONDS);
  return {
    url,
    dialect,
    language: process.env.R2T2_LANGUAGE || "English",
    mode: process.env.R2T2_MODE || "slow",
    secretKey: process.env.R2T2_SECRET_KEY || "test0102",
    // 单次会话上限：中继卡在 30 秒，自部署的没有限制（0 = 不限）。
    maxSeconds: Number.isFinite(capped) && capped >= 0 ? capped : dialect === "native" ? 0 : 30,
    // 注意：system_prompt 会让 LLM 解码器偏向提示里的文本。朗读评分千万别把
    // 原文塞进来 —— 它会把念错的词改回去。只在别的场景下放专有名词。
    systemPrompt: process.env.R2T2_SYSTEM_PROMPT || "",
  };
}

// 送一段 16k 单声道 PCM16，拿回和 mockCommits 同形状的结果。
// pcm: Buffer / Uint8Array / ArrayBuffer
// onEvent: 可选，逐条已提交的词回调，用来做 SSE 的实时推送
// realtime: 按 160ms 真实节奏喂（默认）。批量评测可以关掉抢时间。
export async function streamR2T2(pcm, { onEvent, realtime = true } = {}) {
  const cfg = r2t2Config();
  if (!cfg.url) {
    const err = new Error("R2T2 接口未配置：设置 R2T2_WS_URL，或把 ASR_PROVIDER 设回 mock");
    err.status = 501;
    throw err;
  }
  const audio = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  if (!audio.length) {
    const err = new Error("没有音频");
    err.status = 400;
    throw err;
  }

  const ws = new WebSocket(cfg.url);
  ws.binaryType = "arraybuffer";

  const state = { text: "" };
  const committed = []; // [{type:"word", text, t}]
  let emitted = "";
  let finalText = "";
  const t0 = Date.now();
  let pauses = 0;
  let lastCommitAt = 0;

  const done = new Promise((resolve, reject) => {
    ws.onerror = () => reject(withStatus(new Error("R2T2 连接失败"), 502));
    ws.onclose = (e) =>
      e.code === 1000
        ? resolve()
        : reject(withStatus(new Error(`R2T2 断开 ${e.code} ${e.reason || ""}`), 502));
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let out;
      try {
        out = readReply(cfg.dialect, e.data, state);
      } catch (err) {
        reject(withStatus(err, 502));
        return;
      }
      if (!out) return;
      if (out.final && out.text) finalText = out.text;
      const heard = normalizeHeard(out.text);
      if (heard === emitted) return;
      // 只把新长出来的词发出去 —— 两种方言到这里都已是只增不改的前缀
      const grown = heard.startsWith(emitted) ? heard.slice(emitted.length) : heard;
      emitted = heard;
      const at = Date.now() - t0;
      if (lastCommitAt && at - lastCommitAt > CHUNK_MS * 6) pauses += 1;
      lastCommitAt = at;
      for (const word of grown.match(/[^\s]+/g) || []) {
        const ev = { type: "word", text: word, t: at };
        committed.push(ev);
        onEvent?.(ev);
      }
    };
  });

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.addEventListener("error", () => reject(withStatus(new Error("R2T2 连接失败"), 502)), {
      once: true,
    });
  });
  ws.send(JSON.stringify(buildHeader(cfg.dialect, {
    requestId: `dasheng-${Date.now().toString(36)}`,
    language: cfg.language,
    mode: cfg.mode,
    systemPrompt: cfg.systemPrompt,
    secretKey: cfg.secretKey,
  })));

  const samples = new Int16Array(audio.buffer, audio.byteOffset, Math.floor(audio.byteLength / 2));
  let seq = 1;
  for (let off = 0; off < samples.length; off += FRAME_SAMPLES) {
    ws.send(encodeFrame(cfg.dialect, samples.subarray(off, off + FRAME_SAMPLES), seq++));
    if (realtime) await sleep(CHUNK_MS);
  }
  // 自部署的服务要靠这段静音把最后一个词冲出来
  if (cfg.dialect === "native") {
    const tail = new Int16Array(Math.round(SAMPLE_RATE * (TAIL_SILENCE_MS / 1000)));
    ws.send(encodeFrame(cfg.dialect, tail, seq++));
    if (realtime) await sleep(TAIL_SILENCE_MS);
  }
  ws.send(ASR_EOS);
  await done;

  return {
    events: committed,
    heard: normalizeHeard(finalText || state.text),
    durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
    pauses,
  };
}

function withStatus(err, status) {
  err.status = status;
  return err;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
