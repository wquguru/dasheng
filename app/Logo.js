// 「大」抬在「声」的上方 —— 上下结构，两字不相交（华盖方案：大加宽加粗）。
export default function Logo({ size = 26, label = "大声读" }) {
  const w = Math.round((size * 100) / 130);
  return (
    <svg width={w} height={size} viewBox="0 0 100 130" fill="none" role="img" aria-label={label}>
      <g stroke="currentColor" strokeWidth="11" strokeLinecap="square">
        <path d="M5 20 H95" />
        <path d="M50 20 C43 35 31 49 14 60" />
        <path d="M50 20 C57 35 69 49 86 60" />
      </g>
      <g stroke="currentColor" strokeWidth="8" strokeLinecap="square">
        <path d="M28 74 H72" />
        <path d="M50 74 V89" />
        <path d="M35 89 H65" />
        <path d="M24 99 H76 V109" />
        <path d="M24 109 H76" />
        <path d="M25 99 C23 109 20 117 13 126" />
      </g>
    </svg>
  );
}
