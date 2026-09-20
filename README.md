<img src="docs/logo.svg" width="64" alt="大声读">

# 大声读 · ReadAloud

朗读一段经典英文文稿：R2T2 一边听一边出**稳定前缀**，Jev 逐词判「读的是不是同一个词」，
读完给一个总分，点总分才展开明细。三篇文稿都压到 25–35 词（一遍 12–18 秒），
读之前可以先听一遍范读（浏览器语音合成，念到哪个词高亮哪个词）。标志是「大」抬在「声」上方的上下结构叠字。

## 方法论：为什么是 R2T2 + Jev

```
麦克风 → R2T2（流式转写，只增不改 + 时间戳） → 对齐 → Jev（封闭问题判决） → 本机算术 → 划线 + 总分
```

要点在分工：R2T2 的 **stable prefix**（已提交的词不回改）让划过的线不会闪、判过的分不用重判；
对齐挑出对不上的那几个词，只有它们值得问模型；Jev 只回答预先声明好的封闭问题并给概率；
算术留在本机。

| 评什么 | 谁算 |
|---|---|
| 读对没读对（逐词「是不是同一个词」） | Jev `noul` + 概率 |
| 错误属于哪一类（替换 / ASR 拼写变体 / 自我纠正） | Jev `choice` |
| 听到的还是不是同一句话 | Jev `score`（1–5 级） |
| 漏读、多读、完整度 | 对齐，算术 |
| 语速与停顿 | R2T2 时间戳，算术 |
| 总分 | 本机加权（`lib/score.js` 的 `WEIGHTS`） |
| **发音、重音、口音** | **不出分** — Jev 只读文本，判不了声学，要评得另接音素级发音评测模型 |

## 跑起来

```bash
npm install
npm run dev        # http://localhost:3000（被占用会自动换端口）
npm test           # 对齐 / mock / 节奏算术的单测，不联网
```

`.env.local`（**不要提交**）：

```bash
JEV_API_KEY=sk-ai-v1-...                          # ZenMux 的 key
JEV_ENDPOINT=https://zenmux.ai/api/v1/systemone   # Jev 走自己的 System One 接口，不是 chat/completions
JEV_MODEL=typesafe/jev-1.13

ASR_PROVIDER=r2t2                                 # mock = 不用麦克风，按节奏吐词并预埋三类错误
R2T2_WS_URL=wss://...                             # 见下
R2T2_LANGUAGE=English
```

> 变量叫 `JEV_API_KEY` 而不是 `ZENMUX_API_KEY`：机器 shell 里可能已有别的项目的
> `ZENMUX_API_KEY`，而 shell 变量在 Next 里盖得过 `.env.local`。
> 开了 Clash 之类代理时，Node 的全局 `fetch` 不认 `https_proxy`（curl 认），
> `lib/jev.js` 检测到代理会改用 undici `ProxyAgent` 并显式带上 SNI。

## R2T2 怎么来

模型：[netease-youdao/Confucius4-R2T2](https://huggingface.co/netease-youdao/Confucius4-R2T2)
（Qwen3-ASR 微调，~2B，真流式，最小 160ms 步长）·
[GitHub](https://github.com/netease-youdao/Confucius4-R2T2)

最快：用有道线上 demo 的中继（[r2t2.youdao.com/demo](https://r2t2.youdao.com/demo) 页面里就有
token），单次会话 30 秒上限，填进 `R2T2_WS_URL` 即可。

自部署要 CUDA（Mac 跑不了，infer_mode 绑死 vLLM），步骤与七八个会咬人的坑
——`language` 传错会让流式退化成整句、显存参数按大卡写死、服务默认 `0.0.0.0` + 写死的
secret_key、浏览器采音与离线跑 wav 的两处差异——都在 **[docs/deploy-r2t2.md](docs/deploy-r2t2.md)**。

别设 `R2T2_SYSTEM_PROMPT` 塞原文 —— LLM 解码器会顺着提示把念错的词改回去，分就假了。

## 目录

```
app/page.js   待读 → 朗读中 → 判词中 → 读完（总分钮 → 明细面板）
app/api/      asr：mock 的 SSE 流 / r2t2 的中继地址 · score：一次判分
lib/align.js  词级对齐 —— 决定哪些词值得问 Jev
lib/jev.js    ZenMux System One 客户端（含代理兜底）
lib/score.js  问题构造、判决解析、四项子分与总分
lib/asr.js    provider：mock / r2t2（WebSocket + PCM16）
lib/mic.js    浏览器采音与重采样 · lib/speak.js 范读与逐词高亮
```
