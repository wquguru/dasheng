// JEV (TypeSafe System One) through ZenMux.
//
// Not chat/completions: Jev has its own endpoint and answers only inside a
// closed space you declare up front — `noul` (yes/no probability), `choice`
// (one of N) and `score` (a 2–10 level ordered scale). It reads TEXT ONLY, so
// pronunciation, stress and accent are out of its reach by construction; this
// app never asks it about sound.

const DEFAULT_ENDPOINT = "https://zenmux.ai/api/v1/systemone";
const DEFAULT_MODEL = "typesafe/jev-1.13";

export function jevConfig() {
  return {
    endpoint: process.env.JEV_ENDPOINT || DEFAULT_ENDPOINT,
    model: process.env.JEV_MODEL || DEFAULT_MODEL,
    // JEV_API_KEY 优先：机器的 shell 里可能已经有别的 ZENMUX_API_KEY（别的项目的），
    // 而 shell 环境变量在 Next 里盖得过 .env.local。
    key: process.env.JEV_API_KEY || process.env.ZENMUX_API_KEY || "",
  };
}

// Node 的全局 fetch 不认 https_proxy（curl 认），所以在有代理变量的机器上
// 服务端直连会挂在 TLS 上。用 undici 的 EnvHttpProxyAgent 兜一下，只在需要时加载。
let proxied;
async function pickFetch(endpoint) {
  const proxy =
    process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  if (!proxy) return fetch;
  if (proxied === undefined) {
    try {
      const undici = await import("undici");
      // 两处都不能省：全局 fetch 会丢掉 dispatcher，而 ProxyAgent 不带 servername
      // 时 CONNECT 之后的 TLS 没有 SNI，本机的 Clash 会直接断开。
      const host = new URL(endpoint).hostname;
      const agent = new undici.ProxyAgent({ uri: proxy, requestTls: { servername: host } });
      proxied = (url, init) => undici.fetch(url, { ...init, dispatcher: agent });
    } catch {
      proxied = null;
    }
  }
  return proxied || fetch;
}

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

// One call, many questions: Jev evaluates them in parallel, so a whole
// sentence's verdicts cost one round trip.
export async function ask(state, questions, { signal, timeoutMs = 20000 } = {}) {
  const { endpoint, model, key } = jevConfig();
  if (!key) throw new JevError("JEV_API_KEY / ZENMUX_API_KEY 未配置", 500);
  if (!questions || Object.keys(questions).length === 0) {
    return { model, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const send = await pickFetch(endpoint);
    const res = await send(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, model, questions }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new JevError(`JEV ${res.status}: ${text.slice(0, 300)}`, res.status);
    try {
      return JSON.parse(text);
    } catch {
      throw new JevError(`JEV 返回的不是 JSON: ${text.slice(0, 200)}`, 502);
    }
  } catch (err) {
    if (err instanceof JevError) throw err;
    if (err.name === "AbortError") throw new JevError("JEV 超时", 504);
    const cause = err.cause?.message ? ` (${err.cause.message})` : "";
    const via = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.all_proxy || "直连";
    throw new JevError(`${err.message || "JEV 请求失败"}${cause} · 出口 ${via}`, 502);
  } finally {
    clearTimeout(timer);
  }
}
