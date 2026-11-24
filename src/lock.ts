/**
 * Cross-process advisory lock for the Mikiedi op engine.
 *
 * The in-process mutex (ops.ts withMutex) serializes ops within one daemon
 * process. It cannot coordinate a second process (daemon restart mid-sweep,
 * a second route host, a manual script). This file lock closes that gap:
 * an exclusive create-only lockfile held for the duration of one dispatch.
 * A lock left behind by a crashed process is detected by age (older than
 * the stale threshold, which exceeds the worst-case op duration including
 * the refresh subprocess) and broken. The holder PID is recorded for
 * diagnostics; breaking someone else's live lock is refused.
 */
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export class OpLock {
  readonly path: string;

  constructor(
    dataDir: string,
    private staleMs: number,
    private pollMs = 25,
    private maxWaitMs = 8000,
  ) {
    this.path = join(dataDir, "op.lock");
  }

  /** Blocks (async poll) until the lock is acquired; throws on give-up. */
  async acquire(): Promise<void> {
    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      try {
        const fd = openSync(this.path, "wx");
        try {
          writeFileSync(fd, `${process.pid} ${Date.now()}\n`, "utf8");
        } finally {
          closeSync(fd);
        }
        return;
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code !== "EEXIST") throw e;
        this.maybeBreakStale();
        if (Date.now() >= deadline) {
          throw new Error(`Mikiedi: could not acquire the op lock (${this.path}) within ${this.maxWaitMs}ms`);
        }
        await new Promise((r) => setTimeout(r, this.pollMs));
      }
    }
  }

  release(): void {
    try {
      const raw = readFileSync(this.path, "utf8").trim();
      const [pid] = raw.split(/\s+/);
      if (Number(pid) !== process.pid) return; // not ours; never delete blind
    } catch {
      return; // already gone
    }
    try {
      unlinkSync(this.path);
    } catch {
      // raced with a stale-breaker; nothing to do
    }
  }

  private maybeBreakStale(): void {
    if (!existsSync(this.path)) return;
    let age = 0;
    let holder: string | null = null;
    try {
      age = Date.now() - statSync(this.path).mtimeMs;
      holder = readFileSync(this.path, "utf8").trim().split(/\s+/)[0] ?? null;
    } catch {
      return;
    }
    if (age <= this.staleMs) return;
    // Never break a lock whose recorded holder is a live process — a long
    // op (refresh subprocess) can legitimately hold it past the window.
    // A dead, unknown, or recycled holder allows the break after the full
    // stale window.
    if (holder) {
      const pid = Number(holder);
      if (Number.isFinite(pid) && pid > 0 && processExists(pid)) return;
    }
    try {
      unlinkSync(this.path);
    } catch {
      // lost the race; the next acquire attempt retries
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
