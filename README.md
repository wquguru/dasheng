<div align="center">

<img src="docs/logo.svg" width="72" alt="大声读">

# 大声读 · ReadAloud

**对着屏幕念一段英文，念完就知道哪个词念错了。**

[![Confucius4-R2T2](https://img.shields.io/badge/ASR-Confucius4--R2T2-000?style=flat-square&logo=huggingface&logoColor=white)](https://huggingface.co/netease-youdao/Confucius4-R2T2)
[![Jev](https://img.shields.io/badge/判词-Jev%201.13-5b4ee8?style=flat-square)](https://zenmux.ai/typesafe/jev-1.13)
[![Streaming](https://img.shields.io/badge/流式-160ms%20步长-0aa06e?style=flat-square)](https://huggingface.co/netease-youdao/Confucius4-R2T2)
[![Next.js](https://img.shields.io/badge/Next.js-16-000?style=flat-square&logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![Self-hosted](https://img.shields.io/badge/自部署-12GB%20显存够用-f59e0b?style=flat-square&logo=nvidia&logoColor=white)](docs/deploy-r2t2.md)

</div>

---

英语流利说那一套，一个开源的实时 ASR 模型加一个开源的判词模型就能平替 ——
**而且可以整套跑在你自己的显卡上，不联网、不上传、不按分钟计费。**

念的时候字是一个个亮起来的，念错的当场标红，念完点一下出总分。
一台 12GB 的卡就够。

## 两个模型，各干各的

**R2T2 负责听。** 它是真流式，最低 160ms 的步长往外吐词，还有个叫
**stable prefix** 的机制：已经提交的文本只增不改。传统流式 ASR 会来回改词，
`I want to book` 变成 `I want to look` 再变回来 —— 给人看字幕还行，可下游要是
接了另一个模型，它就得跟着反复撤销自己刚做的判断。正因为有这一层，屏幕上划过的
线不会闪、判过的分不用重判，漏读多读也能直接拿识别结果算。

**Jev 负责判。** 它只在你事先声明好的空间里回答：是否、选一个、1–5 打分，
并且给概率。所以这里只问它文本层面的事 —— 念的是不是原文那个词、错法属于哪一类、
整段意思有没有走样。选它的理由很直接：**快**，一次判决几十到几百毫秒，几乎不花钱。

## 一条链路

```
麦克风 → R2T2（流式转写，只增不改 + 时间戳） → 对齐 → Jev（封闭问题判决） → 本机算术 → 划线 + 总分
```

对齐这一步挑出对不上的那几个词，只有它们值得问模型；剩下的全是算术，留在本机。

| 评什么 | 谁算 |
|---|---|
| 读对没读对（逐词「是不是同一个词」） | Jev `noul` + 概率 |
| 错误属于哪一类（替换 / ASR 拼写变体 / 自我纠正） | Jev `choice` |
| 听到的还是不是同一句话 | Jev `score`（1–5 级） |
| 漏读、多读、完整度 | 对齐，算术 |
| 语速与停顿 | R2T2 时间戳，算术 |
| 总分 | 本机加权（`lib/score.js` 的 `WEIGHTS`） |
| **发音、重音、口音** | **不出分** — Jev 只读文本，判不了声学，要评得另接音素级发音评测模型 |

## 三分钟跑起来

不用显卡也能先看效果 —— `ASR_PROVIDER=mock` 不碰麦克风，按 160ms 的节奏吐词并
预埋三类真实错误，整条判分链路照样跑通。

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

## 接真模型

模型：[netease-youdao/Confucius4-R2T2](https://huggingface.co/netease-youdao/Confucius4-R2T2)
（Qwen3-ASR 微调，~2B，真流式，最小 160ms 步长）·
[GitHub](https://github.com/netease-youdao/Confucius4-R2T2)

**想马上试**：用有道线上 demo 的中继（[r2t2.youdao.com/demo](https://r2t2.youdao.com/demo)
页面里就有 token），单次会话 30 秒上限，填进 `R2T2_WS_URL` 即可。

**想要自己的**：有张 NVIDIA 的卡就行，12GB 够用（Ampere 以上）。跑起来之后音频不出本机，
也没有时长限制。

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
