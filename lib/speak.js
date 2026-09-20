// 范读：用浏览器自带的语音合成念一遍原文，顺便把当前念到的词回调出去，
// 页面就能跟着高亮 —— 没有额外依赖，也不用再托管一份音频。
// 拿不到英语音色的浏览器（少数 Linux）会直接说不支持，不假装在念。

export function canSpeak() {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

function englishVoice() {
  const voices = window.speechSynthesis.getVoices() || [];
  return (
    voices.find((v) => /en[-_]US/i.test(v.lang) && /Samantha|Ava|Natural|Google/i.test(v.name)) ||
    voices.find((v) => /^en/i.test(v.lang)) ||
    null
  );
}

// 返回一个停止函数。onWord(charIndex) 用原文里的字符位置回调，页面按位置找词。
export function speak(text, { onWord, onEnd, rate = 0.85 } = {}) {
  if (!canSpeak()) return () => {};
  const synth = window.speechSynthesis;
  synth.cancel();

  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = rate; // 范读比正常语速慢一档，够跟读
  utter.lang = "en-US";
  const voice = englishVoice();
  if (voice) utter.voice = voice;

  utter.onboundary = (e) => {
    if (e.name === "word" || e.charIndex >= 0) onWord?.(e.charIndex);
  };
  utter.onend = () => onEnd?.();
  utter.onerror = () => onEnd?.();

  // 有些浏览器首次调用时 voices 还没加载好，等一拍再念
  if (!voice && synth.getVoices().length === 0) {
    synth.addEventListener("voiceschanged", () => synth.speak(utter), { once: true });
  } else {
    synth.speak(utter);
  }

  return () => {
    utter.onend = null;
    synth.cancel();
    onEnd?.();
  };
}
