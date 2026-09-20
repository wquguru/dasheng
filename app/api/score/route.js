import { getPassage } from "../../../lib/passages.js";
import { scoreReading } from "../../../lib/score.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 一段读完 → JEV 逐词判同 + 本机算术 → 划线与总分
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const heard = (body.heard || "").trim();
  const reference = body.reference || getPassage(body.passageId).text;
  if (!heard) return Response.json({ error: "没有可判分的文本" }, { status: 400 });

  try {
    const result = await scoreReading({
      reference,
      heard,
      durationMs: Number(body.durationMs) || 0,
      pauses: Number(body.pauses) || 0,
    });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: err.message || "判分失败" }, { status: err.status || 502 });
  }
}
