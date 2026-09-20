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
// 协议（抄自 https://r2t2.youdao.com/demo 的中继，已实测跑通）：
//   1. 连上后先发一帧 JSON header（protocol_version: 2）
//   2. 之后每帧音频是 12 字节头 + PCM16LE：
//        "NAS2" | uint32le 序号(从 1 起) | uint32le 采样点数
//   3. 说完发字符串 YOUDAO_ONETIME_ASR_STREAM_EOS，服务端回一条 is_final
//   每条回包：{status, msg:{text, partial, asr_cost_ms}, timing:{...}}
//   text 是已提交前缀——只增不改，正是这个应用依赖的那条性质。

const ASR_EOS = "YOUDAO_ONETIME_ASR_STREAM_EOS";
const CHUNK_MS = 160;
const SAMPLE_RATE = 16000;

export function r2t2Config() {
  return {
    url: process.env.R2T2_WS_URL || "",
    language: process.env.R2T2_LANGUAGE || "English",
    mode: process.env.R2T2_MODE || "slow",
    // 单次会话上限。有道线上 demo 的中继卡在 30 秒，自部署的可以放开。
    maxSeconds: Number(process.env.R2T2_MAX_SECONDS) || 30,
    // 注意：system_prompt 会让 LLM 解码器偏向提示里的文本。朗读评分千万别把
    // 原文塞进来 —— 它会把念错的词改回去。只在别的场景下放专有名词。
    systemPrompt: process.env.R2T2_SYSTEM_PROMPT || "",
  };
}

// 送一段 16k 单声道 PCM16，拿回和 mockCommits 同形状的结果。
// pcm: Buffer / Uint8Array / ArrayBuffer
// onEvent: 可选，逐条已提交的词回调，用来做 SSE 的实时推送
export async function streamR2T2(pcm, { onEvent, hotwords = "" } = {}) {
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

  const requestId = `dasheng-${Date.now().toString(36)}`;
  const header = {
    requestId,
    protocol_version: 2,
    language: cfg.language,
    mode: cfg.mode,
    sample_rate: SAMPLE_RATE,
    channels: 1,
    use_vad: false,
    traffic_class: "interactive",
    postprocess: false, // 评分要看原样，别让它替我们清理口头禅
    show_partial: true,
    detect: false,
  };
  const prompt = [cfg.systemPrompt, hotwords].filter(Boolean).join("\n");
  if (prompt) header.system_prompt = prompt;

  const ws = new WebSocket(cfg.url);
  ws.binaryType = "arraybuffer";

  const committed = []; // [{text, t}]
  let text = "";
  let finalText = "";
  const t0 = Date.now();
  let pauses = 0;
  let lastCommitAt = 0;

  const done = new Promise((resolve, reject) => {
    ws.onerror = () => reject(withStatus(new Error("R2T2 连接失败"), 502));
    ws.onclose = (e) => (e.code === 1000 ? resolve() : reject(withStatus(new Error(`R2T2 断开 ${e.code} ${e.reason || ""}`), 502)));
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let payload;
      try {
        payload = JSON.parse(e.data);
      } catch {
        return;
      }
      if (payload.status === "error") {
        reject(withStatus(new Error(String(payload.msg || "R2T2 error")), 502));
        return;
      }
      const msg = payload.msg && typeof payload.msg === "object" ? payload.msg : {};
      const next = typeof msg.text === "string" ? msg.text : "";
      if (payload.is_final === true && next) finalText = next;
      if (!next || next === text) return;
      // 只取增量——服务端保证 text 是只增不改的前缀
      const grown = next.startsWith(text) ? next.slice(text.length) : next;
      text = next;
      const at = Date.now() - t0;
      if (lastCommitAt && at - lastCommitAt > CHUNK_MS * 6) pauses += 1;
      lastCommitAt = at;
      for (const raw of grown.match(/[^\s]+/g) || []) {
        const word = raw.replace(/[^A-Za-z0-9’']/g, "").toLowerCase();
        if (!word) continue;
        const ev = { type: "word", text: word, t: at };
        committed.push(ev);
        onEvent?.(ev);
      }
    };
  });

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.addEventListener("error", () => reject(withStatus(new Error("R2T2 连接失败"), 502)), { once: true });
  });
  ws.send(JSON.stringify(header));

  const step = Math.round(SAMPLE_RATE * (CHUNK_MS / 1000)) * 2; // 160ms 的字节数
  let seq = 1;
  for (let off = 0; off < audio.length; off += step) {
    const chunk = audio.subarray(off, Math.min(off + step, audio.length));
    const frame = Buffer.alloc(12 + chunk.length);
    frame.write("NAS2", 0, "ascii");
    frame.writeUInt32LE(seq++, 4);
    frame.writeUInt32LE(chunk.length / 2, 8);
    chunk.copy(frame, 12);
    ws.send(frame);
    await sleep(CHUNK_MS); // 按真实时间喂，才是流式；要快可以整段灌
  }
  ws.send(ASR_EOS);
  await done;

  const heard = (finalText || text)
    .toLowerCase()
    .match(/[a-z0-9’']+/g)
    ?.join(" ") || "";

  return {
    events: committed,
    heard,
    durationMs: Math.round((audio.length / 2 / SAMPLE_RATE) * 1000),
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
