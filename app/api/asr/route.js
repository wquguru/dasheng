import { asrProvider, mockCommits, r2t2Config, streamR2T2 } from "../../../lib/asr.js";
import { getPassage } from "../../../lib/passages.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 页面开口之前先问一句：这台机器上 ASR 是谁。
// r2t2 时把中继地址交给浏览器 —— 它本来就是公开 demo 上的一个 token，
// 而麦克风直连中继比经我们服务端转一道少一次排队。
export async function GET() {
  const provider = asrProvider();
  if (provider !== "r2t2") return Response.json({ provider });
  const cfg = r2t2Config();
  if (!cfg.url) {
    return Response.json(
      { provider, error: "R2T2 接口未配置：设置 R2T2_WS_URL，或把 ASR_PROVIDER 设回 mock" },
      { status: 501 },
    );
  }
  return Response.json({
    provider,
    wsUrl: cfg.url,
    dialect: cfg.dialect,
    language: cfg.language,
    // secret_key 是自部署服务的默认口令（仓库里就写着 test0102），不是密钥
    secretKey: cfg.dialect === "native" ? cfg.secretKey : "",
    maxSeconds: cfg.maxSeconds, // 0 = 不限时
  });
}

// 一个已提交前缀的流：逐词 append，永不回改。事件形状与真 R2T2 接上后一致。
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const passage = getPassage(body.passageId);
  const speed = Number(body.speed) > 0 ? Number(body.speed) : 8; // 回放倍速，只影响 mock

  if (asrProvider() !== "mock") {
    try {
      await streamR2T2();
    } catch (err) {
      return Response.json({ error: err.message }, { status: err.status || 502 });
    }
  }

  const { events, heard, durationMs, pauses } = mockCommits(passage.text);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      send({ type: "start", passageId: passage.id, provider: asrProvider() });
      let last = 0;
      for (const e of events) {
        await sleep((e.t - last) / speed);
        last = e.t;
        send(e);
      }
      send({ type: "done", heard, durationMs, pauses });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}
