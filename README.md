<img src="docs/logo.svg" width="64" alt="大声读">

# 大声读 · ReadAloud

朗读一段经典英文文稿：R2T2 一边听一边出**稳定前缀**，Jev 逐词判「读的是不是同一个词」，
读完给一个总分，点总分才展开明细。标志是「大」抬在「声」上方的上下结构叠字。

## 方法论：为什么是 R2T2 + Jev

```
麦克风 → R2T2（流式转写，只增不改 + 时间戳） → 对齐 → Jev（封闭问题判决） → 本机算术 → 划线 + 总分
```

- **R2T2 负责「听到了什么」**。它的 stable prefix 是关键：已提交的词不会回改，
  所以划过线的词不会闪、不用撤销，判过分的词也不用重判。
- **对齐负责「该问谁」**。原文 ↔ 听到做词级 LCS 对齐，只有对不上的那几个词才值得问模型；
  漏读、多读、完整度到这一步就是算术，根本不需要模型。
- **Jev 负责「这算不算错」**。它只回答预先声明好的封闭问题（`noul` 是非 / `choice` 多选 /
  `score` 1–5 级）并给概率，70–500ms、几乎不要钱。`liberti` 是 ASR 拼写变体还是真念错了，
  这种判断正是它的形状。
- **代码负责算术**。总分是本机加权，不问模型。

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

最快：直接用有道线上 demo 的中继（[r2t2.youdao.com/demo](https://r2t2.youdao.com/demo)
页面里就有 token），单次会话 30 秒上限，填进 `R2T2_WS_URL` 即可。

自部署（要 CUDA，Ampere 以上一张 12G 卡够用，Mac 跑不了 —— infer_mode 绑死 vLLM+CUDA）：

```bash
export HF_ENDPOINT=https://hf-mirror.com          # 国内
huggingface-cli download netease-youdao/Confucius4-R2T2 --local-dir ./r2t2
git clone https://github.com/netease-youdao/Confucius4-R2T2 && cd Confucius4-R2T2
uv venv --python 3.12 && uv pip install -e .      # vLLM 会覆盖镜像自带的 torch，正常
bash run_example.sh --infer_mode stream_vllm --chunk_size_ms 160
```

起好流式服务后把 WebSocket 地址填进 `R2T2_WS_URL`，`R2T2_MAX_SECONDS` 可以放开。
音频格式：16k 单声道 PCM16。**别设 `R2T2_SYSTEM_PROMPT` 塞原文** —— LLM 解码器会顺着提示
把念错的词改回去，分就假了。

## 目录

```
app/page.js            四个状态：待读 → 朗读中 → 判词中 → 读完（总分钮 → 明细面板）
app/api/asr/route.js   ASR 出口：mock 的 SSE 流 / r2t2 的中继地址
app/api/score/route.js 一次判分
lib/align.js           词级对齐 —— 决定哪些词值得问 Jev
lib/jev.js             ZenMux System One 客户端（含代理兜底）
lib/score.js           问题构造、判决解析、四项子分与总分
lib/asr.js             provider：mock / r2t2（WebSocket + PCM16）
lib/mic.js             浏览器端采音与重采样
```
