/** Counts only. Singleton with reference counting so layouts and enrollment can share it. */
export type PresenceBucket = {
  t_s: number;
  keys: number;
  pointer: number;
  wheel: number;
};
let users = 0;
let teardown: (() => void) | undefined;
export function startPresence(): () => void {
  if (typeof window === "undefined") return () => {};
  users += 1;
  if (!teardown) {
    const buckets = new Map<number, PresenceBucket>();
    let busy = false;
    const record = (kind: "keys" | "pointer" | "wheel") => (event: Event) => {
      if (!event.isTrusted) return;
      const t_s = Math.floor(Date.now() / 1000);
      const b = buckets.get(t_s) ?? { t_s, keys: 0, pointer: 0, wheel: 0 };
      b[kind]++;
      buckets.set(t_s, b);
      for (const t of buckets.keys()) if (t < t_s - 20) buckets.delete(t);
    };
    const listeners = [
      ["keydown", record("keys")],
      ["pointerdown", record("pointer")],
      ["wheel", record("wheel")],
    ] as const;
    for (const [type, fn] of listeners)
      window.addEventListener(type, fn, { passive: true });
    const flush = async () => {
      if (busy || !buckets.size) return;
      const now = Math.floor(Date.now() / 1000);
      const pending = [...buckets.values()]
        .filter((b) => b.t_s < now && b.t_s >= now - 20)
        .map((b) => ({ ...b }));
      if (!pending.length) return;
      busy = true;
      try {
        const response = await fetch("/api/web/presence", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ buckets: pending }),
          keepalive: true,
        });
        if (response.ok) for (const b of pending) buckets.delete(b.t_s);
      } catch {
        /* Retry bounded, closed buckets on next interval. */
      } finally {
        busy = false;
      }
    };
    const interval = window.setInterval(() => void flush(), 2000);
    const hide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    document.addEventListener("visibilitychange", hide);
    teardown = () => {
      window.clearInterval(interval);
      for (const [type, fn] of listeners) window.removeEventListener(type, fn);
      document.removeEventListener("visibilitychange", hide);
      void flush();
    };
  }
  let disposed = false;
  return () => {
    if (!disposed) {
      disposed = true;
      users--;
      if (!users) {
        teardown?.();
        teardown = undefined;
      }
    }
  };
}
