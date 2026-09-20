"use client";

// 浏览器这一侧：麦克风 → 16k 单声道 PCM16 → R2T2 的 WebSocket。
//
// 为什么直连而不经我们的服务端：中继那条路上 key 由中继自己注入，我们手里只有
// 一个公开 token；自部署那条路服务就在隧道另一头。两种情况中间再转一道都只是
// 白加一次排队延迟，而这个应用整件事就是要让「已提交前缀」尽快出现在屏幕上。
//
// 两种方言的差异全在 lib/r2t2-protocol.js 里。

import {
  ASR_EOS,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  TAIL_SILENCE_MS,
  buildHeader,
  encodeFrame,
  normalizeHeard,
  readReply,
} from "./r2t2-protocol.js";

export async function recordToR2T2({
  wsUrl,
  dialect = "relay",
  language = "English",
  secretKey = "",
  systemPrompt = "",
  onCommit,
  onLevel,
}) {
  if (!wsUrl) throw new Error("没有 R2T2 地址");

  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // 直接开 16k 的上下文，省掉自己写重采样；浏览器不给就按实际采样率线性抽。
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(media);
  const node = ctx.createScriptProcessor(4096, 1, 1);

  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  const t0 = Date.now();
  const state = { text: "" };
  let finalText = "";
  let seq = 1;
  let pending = new Float32Array(0);
  let closedBy = null;

  const settle = {};
  const done = new Promise((resolve, reject) => {
    settle.resolve = resolve;
    settle.reject = reject;
  });

  const teardown = () => {
    try { node.disconnect(); } catch {}
    try { source.disconnect(); } catch {}
    try { ctx.close(); } catch {}
    media.getTracks().forEach((t) => t.stop());
  };

  ws.onerror = () => {
    teardown();
    settle.reject(new Error("R2T2 连接失败"));
  };
  ws.onclose = (e) => {
    teardown();
    if (closedBy === "eos" || e.code === 1000) {
      settle.resolve({
        heard: normalizeHeard(finalText || state.text),
        durationMs: Date.now() - t0,
      });
    } else {
      settle.reject(new Error(`R2T2 断开 ${e.code}${e.reason ? ` ${e.reason}` : ""}`));
    }
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    let out;
    try {
      out = readReply(dialect, e.data, state);
    } catch (err) {
      closedBy = "error";
      settle.reject(err);
      try { ws.close(); } catch {}
      return;
    }
    if (!out) return;
    if (out.final && out.text) finalText = out.text;
    onCommit?.({
      committed: normalizeHeard(out.text),
      partial: normalizeHeard(out.partial),
      at: Date.now() - t0,
    });
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.addEventListener("error", () => reject(new Error("R2T2 连接失败")), { once: true });
  });

  ws.send(JSON.stringify(buildHeader(dialect, {
    requestId: `dasheng-${Date.now().toString(36)}`,
    language,
    systemPrompt,
    secretKey,
  })));

  node.onaudioprocess = (ev) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const input = ev.inputBuffer.getChannelData(0);
    // 上下文拿不到 16k 时（Safari）按比例抽样，宁可糙一点也别送错采样率
    const scaled = ctx.sampleRate === SAMPLE_RATE ? input : downsample(input, ctx.sampleRate, SAMPLE_RATE);

    let peak = 0;
    for (let i = 0; i < scaled.length; i++) peak = Math.max(peak, Math.abs(scaled[i]));
    onLevel?.(peak);

    const merged = new Float32Array(pending.length + scaled.length);
    merged.set(pending, 0);
    merged.set(scaled, pending.length);
    let off = 0;
    for (; off + FRAME_SAMPLES <= merged.length; off += FRAME_SAMPLES) {
      ws.send(encodeFrame(dialect, toInt16(merged.subarray(off, off + FRAME_SAMPLES)), seq++));
    }
    pending = merged.slice(off);
  };

  source.connect(node);
  node.connect(ctx.destination); // ScriptProcessor 不接出去就不会被调用

  return {
    done,
    stop() {
      if (ws.readyState !== WebSocket.OPEN) return;
      node.onaudioprocess = null;
      if (pending.length) ws.send(encodeFrame(dialect, toInt16(pending), seq++)); // 不满一帧的尾巴
      pending = new Float32Array(0);
      // 自部署的服务要靠这段静音把最后一个词冲出来，中继不需要
      if (dialect === "native") {
        const tail = new Int16Array(Math.round(SAMPLE_RATE * (TAIL_SILENCE_MS / 1000)));
        ws.send(encodeFrame(dialect, tail, seq++));
      }
      closedBy = "eos";
      ws.send(ASR_EOS);
      teardown();
    },
    abort() {
      closedBy = "eos";
      try { ws.close(1000); } catch {}
      teardown();
    },
  };
}

function toInt16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function downsample(input, from, to) {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}
