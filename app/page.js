"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Logo from "./Logo.js";
import { PASSAGES } from "../lib/passages.js";
import { align, tokenize } from "../lib/align.js";
import { canSpeak, speak } from "../lib/speak.js";
import { recordToR2T2 } from "../lib/mic.js";

const BEST = {}; // 本次会话里每篇的最好成绩，够用，不落库

export default function Page() {
  const [passageId, setPassageId] = useState(PASSAGES[0].id);
  const [phase, setPhase] = useState("idle"); // idle | reading | scoring | done
  const [heard, setHeard] = useState("");
  const [result, setResult] = useState(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(() => new Array(14).fill(0));
  const [duration, setDuration] = useState(0);
  const [demoAt, setDemoAt] = useState(-1); // 范读念到哪个词
  // 服务端不知道这台浏览器有没有语音合成，等挂载后再决定按钮出不出，免得水合不一致
  const [canDemo, setCanDemo] = useState(false);
  const stopDemo = useRef(null);
  const abort = useRef(null);
  const mic = useRef(null);
  const stopRef = useRef(null);
  const stats = useRef({ durationMs: 0, pauses: 0 });
  const [asr, setAsr] = useState(null); // { provider, wsUrl, language }

  // 这台机器上 ASR 是谁：mock 还是真的 R2T2
  useEffect(() => {
    let alive = true;
    fetch("/api/asr")
      .then((r) => r.json())
      .then((d) => alive && setAsr(d))
      .catch(() => alive && setAsr({ provider: "mock" }));
    return () => {
      alive = false;
    };
  }, []);

  const passage = useMemo(() => PASSAGES.find((p) => p.id === passageId), [passageId]);
  const words = useMemo(() => tokenize(passage.text), [passage]);

  // 朗读中的划线：本地对齐先给出「读到哪、哪个词对不上」，JEV 的判决在读完后覆盖它
  const liveMarks = useMemo(() => {
    if (!heard) return { marks: [], cursor: 0 };
    const a = align(passage.text, heard);
    const marks = new Array(words.length).fill(null);
    a.matched.forEach((op) => (marks[op.refIndex] = "ok"));
    a.substitutions.forEach((s) => (marks[s.refIndex] = "doubt"));
    const cursor = marks.reduce((acc, m, i) => (m ? i + 1 : acc), 0);
    return { marks, cursor };
  }, [heard, passage, words.length]);

  const finalMarks = result?.marks;

  useEffect(() => {
    if (phase !== "reading") return;
    const t0 = Date.now();
    // 中继有单次会话上限（线上 demo 是 30 秒），到点前自己收尾，
    // 比被服务端切掉强 —— 至少最后一版 is_final 还能拿到。
    // maxSeconds 为 0（自部署）就是不限时
    const capMs =
      asr?.provider === "r2t2" && asr.maxSeconds > 0 ? asr.maxSeconds * 1000 - 1200 : Infinity;
    const tick = setInterval(() => {
      const now = Date.now() - t0;
      setElapsed(now);
      if (now >= capMs) stopRef.current?.();
    }, 200);
    // 真麦克风时电平由 onLevel 推，这里只在 mock 下假装有人在说话
    const pulse =
      asr?.provider === "r2t2"
        ? null
        : setInterval(
            () => setLevel(Array.from({ length: 14 }, (_, i) => (i < 7 ? 6 + Math.random() * 16 : 6))),
            120,
          );
    return () => {
      clearInterval(tick);
      if (pulse) clearInterval(pulse);
    };
  }, [phase, asr]);

  const start = useCallback(async () => {
    setError("");
    setHeard("");
    setResult(null);
    setOpen(false);
    setElapsed(0);
    stopDemo.current?.();
    setPhase("reading");
    const controller = new AbortController();
    abort.current = controller;

    let text = "";
    if (asr?.provider === "r2t2") {
      // 真 R2T2：麦克风直连中继，屏幕上的划线跟着它的已提交前缀走
      try {
        // 不给热词。R2T2 的解码器是 LLM：把原文喂进 system_prompt 等于提前
        // 告诉它答案 —— 实测它会把念错的词"纠正"回原文，还会把提示词整段
        // 复述一遍贴在结果前面。评分要的是它真听到了什么。
        const session = await recordToR2T2({
          wsUrl: asr.wsUrl,
          dialect: asr.dialect || "relay",
          language: asr.language || "English",
          secretKey: asr.secretKey || "",
          onCommit: ({ committed, partial }) => {
            text = committed;
            setHeard(partial ? `${committed} ${partial}` : committed);
          },
          onLevel: (peak) => {
            const n = Math.round(Math.min(1, peak * 2.2) * 14);
            setLevel(Array.from({ length: 14 }, (_, i) => (i < n ? 6 + Math.min(1, peak * 2.2) * 16 : 6)));
          },
        });
        mic.current = session;
        const out = await session.done;
        mic.current = null;
        text = out.heard || text;
        stats.current = { durationMs: out.durationMs, pauses: 0 };
        setDuration(out.durationMs || 0);
        setHeard(text);
      } catch (err) {
        mic.current = null;
        setError(err.message);
        setPhase("idle");
        return;
      }
    } else {
      try {
        const res = await fetch("/api/asr", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ passageId }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const detail = await res.json().catch(() => ({}));
          throw new Error(detail.error || `ASR ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() || "";
          for (const chunk of chunks) {
            const line = chunk.replace(/^data: /, "").trim();
            if (!line) continue;
            const e = JSON.parse(line);
            if (e.type === "word") {
              text = text ? `${text} ${e.text}` : e.text;
              setHeard(text);
            } else if (e.type === "done") {
              text = e.heard || text;
              stats.current = { durationMs: e.durationMs, pauses: e.pauses };
              setDuration(e.durationMs || 0);
              setHeard(text);
            }
          }
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          setError(err.message);
          setPhase("idle");
          return;
        }
      }
    }

    if (!text.trim()) {
      setPhase("idle");
      return;
    }

    setPhase("scoring");
    try {
      const res = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          passageId,
          reference: passage.text,
          heard: text,
          durationMs: stats.current.durationMs || elapsed,
          pauses: stats.current.pauses || 0,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `判分 ${res.status}`);
      setResult(data);
      BEST[passageId] = Math.max(BEST[passageId] || 0, data.overall);
      setPhase("done");
    } catch (err) {
      setError(err.message);
      setPhase("idle");
    }
  }, [passageId, passage, elapsed, asr]);

  // 停：真麦克风是「说完了」（送 EOS 等最后一版），mock 是掐断流
  // 范读：听一遍再读。念到哪个词就高亮哪个词。
  const playDemo = useCallback(() => {
    if (stopDemo.current) {
      stopDemo.current();
      stopDemo.current = null;
      setDemoAt(-1);
      return;
    }
    setDemoAt(0);
    stopDemo.current = speak(passage.text, {
      onWord: (charIndex) => {
        const i = words.findIndex((w) => charIndex >= w.start && charIndex < w.end);
        if (i >= 0) setDemoAt(i);
      },
      onEnd: () => {
        stopDemo.current = null;
        setDemoAt(-1);
      },
    });
  }, [passage, words]);

  useEffect(() => {
    setCanDemo(canSpeak());
    return () => stopDemo.current?.();
  }, []);

  const stop = useCallback(() => {
    if (mic.current) mic.current.stop();
    else abort.current?.abort();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== "Space" || e.target.tagName === "INPUT") return;
      e.preventDefault();
      if (phase === "idle") start();
      else if (phase === "reading") stop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, start, stop]);

  useEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  const pick = (id) => {
    if (phase === "reading" || phase === "scoring") return;
    stopDemo.current?.();
    setDemoAt(-1);
    setPassageId(id);
    setPhase("idle");
    setHeard("");
    setResult(null);
    setOpen(false);
  };

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="mark">
            <Logo size={26} />
          </span>
          <span className="word">大声读</span>
        </div>
        <div className="tools">
          {phase === "done" && <button onClick={start}>再读一次</button>}
          <span className="source">
            {phase === "reading"
              ? asr?.provider !== "r2t2"
                ? "R2T2 · 160 MS 步长 · MOCK"
                : asr.dialect === "native"
                  ? "R2T2 · 160 MS 步长 · 自部署"
                  : "R2T2 · 160 MS 步长 · 线上中继"
              : phase === "scoring"
                ? "JEV 判词中…"
                : ""}
          </span>
        </div>
      </header>

      <div className="stage">
        <div className="meta">
          <span>{passage.title}</span>
          <span className="sep" />
          <span>{passage.byline}</span>
          {result && (
            <>
              <span className="sep" />
              <span>{result.wpm} WPM</span>
            </>
          )}
        </div>

        <p className={`passage ${phase === "idle" ? "idle" : ""} ${phase === "done" ? "done" : ""}`}>
          {words.map((w, i) => (
            <span key={i}>
              <span className={`w ${wordClass({ i, phase, finalMarks, live: liveMarks, demoAt })}`}>{w.raw}</span>
              {tail(passage.text, words, i)}
            </span>
          ))}
        </p>

        {(phase === "reading" || phase === "scoring") && <div className="heard">{heard}</div>}

        {phase !== "idle" && (
          <div className="legend">
            <span>
              <i style={{ background: "var(--doubt)" }} />
              存疑
            </span>
            <span>
              <i style={{ background: "var(--wrong)" }} />
              读成了别的词
            </span>
            {result?.missed?.length > 0 && (
              <span>
                <i style={{ background: "var(--ink-4)", height: 1 }} />
                漏读 {result.missed.length} 词
              </span>
            )}
          </div>
        )}

        {error && <div className="err">{error}</div>}
      </div>

      <div className="rail">
        <div className="side">
          {phase !== "idle" && (
            <>
              <div className="readout">
                <span>{fmt(phase === "done" ? duration : elapsed)}</span>
                {phase === "reading" && (
                  <span>
                    <span className="label">已读对</span>
                    {liveMarks.marks.filter((m) => m === "ok").length} / {liveMarks.cursor || 0}
                  </span>
                )}
              </div>
              {phase === "reading" && (
                <div className="level">
                  {level.map((h, i) => (
                    <b key={i} style={{ height: `${h}px`, background: h > 6 ? "var(--ink-2)" : "var(--hair)" }} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="mic">
          {phase === "idle" && (
            <>
              <div className="idle-acts">
                <button className="primary" onClick={start}>
                  开始朗读
                </button>
                {canDemo && (
                  <button onClick={playDemo}>
                    {demoAt >= 0 ? "停止范读" : "先听一遍范读"}
                  </button>
                )}
              </div>
              <span className="hint">按 SPACE 开始 · 音频不落盘</span>
            </>
          )}
          {phase === "reading" && (
            <>
              <button className="knob" aria-label="停止朗读" onClick={stop}>
                <span className="stop" />
              </button>
              <span className="hint">
                SPACE 停止
                {asr?.provider === "r2t2" && asr.maxSeconds > 0
                  ? ` · 还剩 ${Math.max(0, Math.ceil(asr.maxSeconds - elapsed / 1000))}s`
                  : ""}
              </span>
            </>
          )}
          {phase === "scoring" && <span className="hint">JEV 判词中…</span>}
          {phase === "done" && result && (
            <>
              <button className="knob score" onClick={() => setOpen((v) => !v)} aria-label="展开明细">
                <span className="total">{result.overall}</span>
              </button>
              <span className="hint plain">
                {open ? "点这里收起" : "点开看明细"}
                {BEST[passageId] ? ` · 最好 ${BEST[passageId]}` : ""}
              </span>
            </>
          )}
        </div>

        <div className="side right" />
      </div>

      <div className="cards">
        <div className="grid">
          {PASSAGES.map((p) => (
            <button
              key={p.id}
              className={`card ${p.id === passageId ? "on" : ""}`}
              onClick={() => pick(p.id)}
            >
              <span className="row">
                <span className="name">{p.title}</span>
                <span className="tag">
                  {p.id === passageId
                    ? phase === "reading"
                      ? "朗读中"
                      : phase === "done"
                        ? `刚读完 ${result?.overall ?? ""}`
                        : "已选"
                    : BEST[p.id]
                      ? `最好 ${BEST[p.id]}`
                      : "未读"}
                </span>
              </span>
              <span className="byline">{p.byline}</span>
            </button>
          ))}
        </div>
        <button className="paste" disabled>
          粘贴自己的文稿
        </button>
      </div>

      {open && result && <Sheet result={result} onClose={() => setOpen(false)} onAgain={start} />}
    </div>
  );
}

function Sheet({ result, onClose, onAgain }) {
  const rows = [
    ...result.verdicts
      .filter((v) => v.status !== "ok")
      .map((v) => ({ from: v.word, to: v.heard, status: v.status })),
    ...(result.missed.length
      ? [{ from: `${result.missed[0].word} …`, to: `漏读 ${result.missed.length} 词`, status: "missed" }]
      : []),
  ].slice(0, 4);

  return (
    <div className="sheet" role="dialog" aria-label="成绩明细">
      <span className="handle" />
      <div className="top">
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span className="big">{result.overall}</span>
          <span className="delta">{result.jev?.questions ?? 0} 个判决</span>
        </div>
        <div className="subs">
          <Sub k="读对" v={result.sub.correct} pct={result.sub.correct} />
          <Sub k="完整" v={result.sub.complete} pct={result.sub.complete} />
          <Sub k="节奏" v={result.sub.pace} pct={result.sub.pace} />
          <Sub k="达意" v={result.sub.meaning} pct={(result.sub.meaning / 5) * 100} />
        </div>
      </div>

      <div className="diffs">
        {result.unjudged?.length > 0 && (
          <div className="diff">
            <span className="from doubt">未判定</span>
            <span className="arrow">→</span>
            <span className="to">{result.unjudged.length} 个替换词受问题上限影响，仍计入已读完整度</span>
          </div>
        )}
        {rows.length === 0 && !result.unjudged?.length && (
          <div className="diff"><span className="to">没有可看的差异 — 全读对了</span></div>
        )}
        {rows.map((r, i) => (
          <div className="diff" key={i}>
            <span className={`from ${r.status}`}>{r.from}</span>
            <span className="arrow">→</span>
            <span className="to">{r.to}</span>
          </div>
        ))}
      </div>

      <div className="foot">
        <span className="source">JEV 判词 · 时间戳算节奏 · 不评发音</span>
        <div className="acts">
          <button onClick={onClose}>收起</button>
          <button className="primary" onClick={onAgain}>
            再读一次
          </button>
        </div>
      </div>
    </div>
  );
}

function Sub({ k, v, pct }) {
  return (
    <div className="sub">
      <div className="row">
        <span className="k">{k}</span>
        <span className="v">{v}</span>
      </div>
      <div className="bar">
        <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
      </div>
    </div>
  );
}

function wordClass({ i, phase, finalMarks, live, demoAt }) {
  if (phase === "idle") return i === demoAt ? "demo" : "";
  if (finalMarks) return finalMarks[i]?.status || "missed";
  const m = live.marks[i];
  if (m) return m;
  if (i === live.cursor) return "cursor";
  return "ahead";
}

// 词与词之间的原始标点、空格照原样留下
function tail(text, words, i) {
  const from = words[i].end;
  const to = i + 1 < words.length ? words[i + 1].start : text.length;
  return text.slice(from, to);
}

function fmt(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
