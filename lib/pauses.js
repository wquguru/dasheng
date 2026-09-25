const PAUSE_THRESHOLD_MS = 1200;

export function recordCommitTimestamp(stats, at) {
  if (!Number.isFinite(at)) return;
  if (stats.lastCommitAt !== null && at - stats.lastCommitAt > PAUSE_THRESHOLD_MS) {
    stats.pauses += 1;
  }
  stats.lastCommitAt = at;
}
