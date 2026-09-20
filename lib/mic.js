"use client";

// 浏览器这一侧：麦克风 → 16k 单声道 PCM16 → R2T2 中继的 WebSocket。
//
// 为什么直连而不走我们自己的服务端：R2T2 的中继就挂在人家 demo 的 origin 上，
// key 由那个中继自己注入，我们手里只有一个公开 token。中间再转一道只会白加一
// 次排队延迟，而这个应用整件事就是要让「已提交前缀」尽快出现在屏幕上。
//
// 协议与 lib/asr.js 里服务端那份完全一致：
//   JSON header → 每帧 "NAS2"+seq+samples+PCM16LE → 字符串 EOS → is_final

const CHUNK_MS = 160;
const RATE = 16000;
const FRAME = Math.round(RATE * (CHUNK_MS / 1000)); // 2560 个采样点

export async function recordToR2T2({ wsUrl, language = "English", hotwords = "", onCommit, onLevel }) {
  if (!wsUrl) throw new Error("没有 R2T2 地址");

  const media = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  // 直接开 16k 的上下文，省掉自己写重采样；浏览器不给就按实际采样率线性抽。
  const ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: RATE });
  const source = ctx.createMediaStreamSource(media);
  const node = ctx.createScriptProcessor(4096, 1, 1);

  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  const t0 = Date.now();
  let committed = ""; // 服务端的已提交前缀：只增不改
  let partial = "";
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
        heard: normalize(finalText || committed),
        durationMs: Date.now() - t0,
      });
    } else {
      settle.reject(new Error(`R2T2 断开 ${e.code}${e.reason ? ` ${e.reason}` : ""}`));
    }
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    if (payload.status === "error") {
      closedBy = "error";
      settle.reject(new Error(String(payload.msg?.msg || payload.msg || "R2T2 出错")));
      try { ws.close(); } catch {}
      return;
    }
    const msg = payload.msg && typeof payload.msg === "object" ? payload.msg : {};
    if (typeof msg.text === "string" && msg.text) {
      if (payload.is_final === true) finalText = msg.text;
      committed = msg.text;
    }
    if (typeof msg.partial === "string") partial = msg.partial;
    onCommit?.({ committed: normalize(committed), partial: normalize(partial), at: Date.now() - t0 });
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.addEventListener("error", () => reject(new Error("R2T2 连接失败")), { once: true });
  });

  ws.send(JSON.stringify({
    requestId: `dasheng-${Date.now().toString(36)}`,
    protocol_version: 2,
    language,
    mode: "slow",
    sample_rate: RATE,
    channels: 1,
    use_vad: false,
    traffic_class: "interactive",
    postprocess: false, // 评分要看原样，别让服务端替我们清掉重复和口头禅
    show_partial: true,
    detect: false,
    ...(hotwords ? { system_prompt: hotwords } : {}),
  }));

  node.onaudioprocess = (ev) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const input = ev.inputBuffer.getChannelData(0);
    // 上下文拿不到 16k 时（Safari）按比例抽样，宁可糙一点也别送错采样率
    const scaled = ctx.sampleRate === RATE ? input : downsample(input, ctx.sampleRate, RATE);

    let peak = 0;
    for (let i = 0; i < scaled.length; i++) peak = Math.max(peak, Math.abs(scaled[i]));
    onLevel?.(peak);

    const merged = new Float32Array(pending.length + scaled.length);
    merged.set(pending, 0);
    merged.set(scaled, pending.length);
    let off = 0;
    for (; off + FRAME <= merged.length; off += FRAME) {
      ws.send(frame(merged.subarray(off, off + FRAME), seq++));
    }
    pending = merged.slice(off);
  };

  source.connect(node);
  node.connect(ctx.destination); // ScriptProcessor 不接出去就不会被调用

  return {
    done,
    stop() {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (pending.length) ws.send(frame(pending, seq++)); // 最后不满一帧的尾巴
      pending = new Float32Array(0);
      closedBy = "eos";
      ws.send("YOUDAO_ONETIME_ASR_STREAM_EOS");
      node.onaudioprocess = null;
      teardown();
    },
    abort() {
      closedBy = "eos";
      try { ws.close(1000); } catch {}
      teardown();
    },
  };
}

function frame(samples, seq) {
  const buf = new ArrayBuffer(12 + samples.length * 2);
  const view = new DataView(buf);
  new Uint8Array(buf).set([0x4e, 0x41, 0x53, 0x32], 0); // NAS2
  view.setUint32(4, seq, true);
  view.setUint32(8, samples.length, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(12 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

function downsample(input, from, to) {
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = input[Math.floor(i * ratio)];
  return out;
}

// 判分链路只认小写词序列，标点由对齐那边自己处理
function normalize(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9’']+/g) || []).join(" ");
}
