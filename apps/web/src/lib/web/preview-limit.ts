import { ApiError } from "../supabase/api";

/** Instance-local backpressure, not a distributed quota or billing guarantee. */
export class PreviewLimiter {
  private readonly users = new Map<string, { startedAt: number; count: number; active: number }>();
  private active = 0;
  constructor(private readonly now = () => Date.now()) {}

  reserve(userId: string): () => void {
    const now = this.now();
    for (const [id, entry] of this.users) {
      if (entry.active === 0 && now - entry.startedAt >= 60_000) this.users.delete(id);
    }
    let entry = this.users.get(userId);
    if (!entry && this.users.size >= 256)
      throw new ApiError(429, "WEB_BUSY", "网页提取服务繁忙，请稍后重试。");
    entry ??= { startedAt: now, count: 0, active: 0 };
    if (now - entry.startedAt >= 60_000) {
      entry.startedAt = now;
      entry.count = 0;
    }
    if (entry.count >= 10 || entry.active >= 2 || this.active >= 4)
      throw new ApiError(429, "WEB_BUSY", "网页提取请求过于频繁，请稍后重试。");
    entry.count++;
    entry.active++;
    this.active++;
    this.users.set(userId, entry);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      entry.active--;
      this.active--;
    };
  }
}

export const previewLimiter = new PreviewLimiter();
