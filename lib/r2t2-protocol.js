// R2T2 的两种方言。浏览器和服务端共用这一份，别再各写一遍。
//
// relay  — 有道线上 demo（r2t2.youdao.com）自己的中继。
//          路径 /asr?t=<token>，首帧带 protocol_version: 2，
//          音频帧要套 12 字节 "NAS2" 头，msg.text 是**完整的已提交前缀**。
//          单次会话 30 秒上限。
//
// native — 仓库自带的 Sanic 服务（run_start_server.sh 起的那个），自部署就是它。
//          路径 /asr_stream_api_v1，首帧字段完全不同且要 secret_key，
//          音频帧是**裸 PCM，没有头**，msg.text 是**增量**，客户端自己拼。
//          没有时长上限，语言可以选 zhen（中英混）。
//
// 两边一样的部分：16k 单声道 PCM16、160ms 一帧、同一个 EOS 字符串。

export const ASR_EOS = "YOUDAO_ONETIME_ASR_STREAM_EOS";
export const CHUNK_MS = 160;
export const SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = Math.round(SAMPLE_RATE * (CHUNK_MS / 1000)); // 2560

// 自部署的服务在 EOS 之前要再收一段静音，否则最后一个词出不来 —— 仓库自带的
// ws_client.py 就是这么干的（末帧补 0.5s 零）。中继那边不需要。
export const TAIL_SILENCE_MS = 500;

export function detectDialect(url) {
  return /asr_stream_api/.test(String(url || "")) ? "native" : "relay";
}

export function buildHeader(dialect, { requestId, language = "English", mode = "slow", systemPrompt = "", secretKey = "" }) {
  if (dialect === "native") {
    return {
      requestId,
      channels: 1,
      sample_rate: SAMPLE_RATE,
      language, // zhen / Chinese / English
      use_vad: false,
      secret_key: secretKey || "test0102",
      mode,
    };
  }
  const header = {
    requestId,
    protocol_version: 2,
    language,
    mode,
    sample_rate: SAMPLE_RATE,
    channels: 1,
    use_vad: false,
    traffic_class: "interactive",
    postprocess: false, // 评分要看原样，别让服务端替我们清掉重复和口头禅
    show_partial: true,
    detect: false,
  };
  if (systemPrompt) header.system_prompt = systemPrompt;
  return header;
}

// samples: Int16Array。relay 要套头，native 直接发裸 PCM。
export function encodeFrame(dialect, samples, seq) {
  if (dialect === "native") {
    return samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength);
  }
  const buf = new ArrayBuffer(12 + samples.byteLength);
  const view = new DataView(buf);
  new Uint8Array(buf).set([0x4e, 0x41, 0x53, 0x32], 0); // NAS2
  view.setUint32(4, seq, true);
  view.setUint32(8, samples.length, true);
  new Int16Array(buf, 12).set(samples);
  return buf;
}

// 把一条回包收敛成 {text, partial, final}。text 一律是**到此为止的完整前缀**：
// native 的增量在这里累加掉，上层两种方言看到的形状就一样了。
export function readReply(dialect, raw, state) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (payload.status === "error") {
    const detail = payload.msg?.msg ?? payload.msg ?? payload.error;
    throw new Error(typeof detail === "string" && detail ? detail : "R2T2 出错");
  }
  const msg = payload.msg && typeof payload.msg === "object" ? payload.msg : null;
  if (!msg) return null; // {"status":"connected"} 和空包

  if (dialect === "native") {
    // reset 是「这一段结束了，下一段重新开始」，不是「前面说的不算」。
    // 自部署的服务在收尾时会发一条 reset:true —— 清掉已攒的文本就全没了。
    const delta = typeof msg.text === "string" ? msg.text : "";
    if (!delta) return null;
    state.text += delta;
    return { text: state.text, partial: "", final: payload.is_final === true };
  }

  const text = typeof msg.text === "string" ? msg.text : "";
  if (text) state.text = text; // 中继给的本来就是完整前缀
  return {
    text: state.text,
    partial: typeof msg.partial === "string" ? msg.partial : "",
    final: payload.is_final === true,
  };
}

// 判分链路只认小写词序列，标点交给对齐那边
export function normalizeHeard(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9’']+/g) || []).join(" ");
}
