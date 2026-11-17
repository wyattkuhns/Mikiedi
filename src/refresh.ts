/**
 * Retrieval-index refresh.
 *
 * After pages change, Cadet's retrieval index must be invalidated so the
 * next turn rebuilds lanes from the fresh pages. `memory v3 rebuild-index`
 * is the documented, supported operator command; the bridge runs it as a
 * subprocess. If it cannot run (CLI missing from PATH, timeout, error),
 * publication stays valid — the bridge records `pendingRefresh` and every
 * status report says so honestly, with the manual command documented.
 */
import { spawn } from "node:child_process";

export interface RefreshResult {
  ok: boolean;
  detail: string;
}

export function runRebuildIndex(opts: {
  cliPath: string;
  workspaceDir: string;
  timeoutMs: number;
}): Promise<RefreshResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (result: RefreshResult) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let child;
    try {
      child = spawn(opts.cliPath, ["memory", "v3", "rebuild-index"], {
        cwd: opts.workspaceDir,
        env: { ...process.env, CADET_WORKSPACE_DIR: opts.workspaceDir },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: unknown) {
      done({ ok: false, detail: `could not spawn ${opts.cliPath}: ${String(e)}` });
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      done({ ok: false, detail: `refresh timed out after ${opts.timeoutMs}ms; run manually: ${opts.cliPath} memory v3 rebuild-index` });
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", (e) => {
      clearTimeout(timer);
      done({ ok: false, detail: `refresh failed to start (${e.message}); run manually: ${opts.cliPath} memory v3 rebuild-index` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = `${stdout}${stderr}`.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
      if (code === 0) {
        done({ ok: true, detail: tail !== "" ? tail : "rebuild-index completed" });
      } else {
        done({
          ok: false,
          detail: `rebuild-index exited with code ${code}${tail ? `: ${tail}` : ""}; run manually: ${opts.cliPath} memory v3 rebuild-index`,
        });
      }
    });
  });
}
