# 自部署 R2T2

要 CUDA，Mac 跑不了 —— infer_mode 绑死 vLLM。

**这份文档只收通用的坑**：换一台机器、换一个云、换一个镜像照样会咬人的那些。
具体机器上的路径、镜像名、耗时分钟数一律不写进来（它们只对某一台机成立，
写下来反而误导下一个人）。个别条目注明了验证范围。

## 最短路径

```bash
# 1. 用预装 vLLM 的镜像，开机先确认版本窗口——这一步决定后面所有事
python -c "import vllm,transformers,torch,importlib.metadata as m; \
  print(vllm.__version__, transformers.__version__, torch.__version__); \
  print([r for r in m.requires('vllm') if 'transformers' in r])"

# 2. 别 pip install -e .（会拖进整棵 vLLM 依赖树，把预装的顶掉）
pip install --no-deps qwen-asr
pip install librosa soundfile sox fireredvad sanic pytz qwen-omni-utils flask accelerate
pip install transformers==4.57.6        # qwen-asr 硬 pin；先确认在上一步查到的窗口内

# 3. 两份权重：模型（约 3.9GB）+ 服务端必需的 VAD（仓库不带、README 不提）
hf download netease-youdao/Confucius4-R2T2 --local-dir ./r2t2
hf download FireRedTeam/FireRedVAD --local-dir ./vad

# 4. 先改显存再启动：example.py 与 ws_server.py 各改两处
#    gpu_memory_utilization → 0.9，max_model_len → 8192
# 5. 先用 example.py 验模型（那条路不需要 VAD），再起 WebSocket 服务
./run_example.sh resources/test.wav --model_path ./r2t2 --infer_mode stream_vllm --chunk_size_ms 160
./run_start_server.sh start --model_path ./r2t2 --vad_model_path ./vad/Stream-VAD --port 8272
```

## 会咬人的

- **`language` 必须显式传**。客户端默认 `zhen`（中英混合）会让流式退化成整句输出：
  同一段音频、同一个服务，`zhen` 时前 36 个 chunk 全返回空、最后一次性吐完，首字 5.85s；
  换成 `Chinese` 后首字 1.68s 并逐词增量。stable prefix 的卖点直接没了，对朗读打分致命。
  （在一条中文样本上验证；要中英混读得自己在目标音频上复测。）`mode` 的 slow/fast 无差别。
- **显存参数是按大显存卡写死的**。`example.py` 是 `gpu_memory_utilization=0.4`、
  `ws_server.py` 是 0.95；0.4 × 12GB = 4.8GB，而权重就占 4.08GB，直接
  `No available memory for the cache blocks`。同时 `max_model_len` 默认 65536 要约 7GB
  KV cache（报错会告诉你实际能开多长）。**两处都改才起得来**，≤16GB 的卡必中。
- **transformers 版本是个夹缝**。qwen-asr 硬 pin 老版本，不降会炸在
  `check_model_inputs() missing 1 required positional argument`；但降之前必须确认
  你这套 vLLM 允许的区间（上面第 1 步），窗口随 vLLM 版本变，**别照抄 4.57.6**。
- **WebSocket 别走平台的 HTTP 反代**（各家云的「端口映射」多半是 HTTP 反代），
  长连接不可靠；用 SSH 隧道，或自己配支持 upgrade 的反代。
- **服务默认绑 `0.0.0.0`，`secret_key` 是仓库里写死的 `test0102`**。实际部署后不到一小时，
  日志里就出现了来源不明的外部探测连接，用的正是这个默认 key。浏览器链路意味着服务必须
  对外可达 —— 绑 127.0.0.1 + 自己的反代 + 换 key + 加鉴权，别裸奔。
- **浏览器采音有两处离线跑 wav 看不出来的差异**：AudioContext 通常是 48k，重采样到 16k 的
  质量与 librosa 不同，会直接影响分数（同一段音频两条路各跑一次做对比）；离线客户端是
  尽可能快地发包，测出来的是吞吐不是延迟，真麦克风必须按 wall clock 重测。
- **服务端关掉了 ws 的 ping/pong**（注释说是避免同步推理阻塞 event loop 时 pong 超时），
  不会主动探活；切后台、熄屏、换网络时服务端不知道，长会话要自己做应用层心跳与重连。
- **别设 `R2T2_SYSTEM_PROMPT` 塞原文** —— LLM 解码器会顺着提示把念错的词改回去，分就假了。

## 还没人验证过的

长连接稳定性、并发、VAD 切句行为、chunk_size 扫描（80/160/320/640ms）、英文表现。
另外上游把 VAD 强制开着（`if True or use_vad:`，客户端的 `use_vad` 只控制下游分支），
并带幻觉检测与重复检测，可能改写转写结果 —— 朗读打分里如果有故意的重复，先读那段代码。
