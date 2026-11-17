/**
 * Route-adapter tests: exercises routes/bridge.ts (the actual HTTP handler)
 * with synthetic Requests against a temporary workspace, without a Cadet
 * runtime. Proves the adapter resolves config/paths from the environment
 * and delegates correctly to the op engine.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GET, POST } from "../routes/bridge.ts";

let ws = "";

beforeAll(() => {
  ws = join(tmpdir(), `mikiedi-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(ws, "memory", "concepts"), { recursive: true });
  process.env.CADET_WORKSPACE_DIR = ws;
  // The adapter reads config.json from the plugin root; for this test the
  // refresh CLI is a stub that always fails (exit 1), which also exercises
  // the pendingRefresh path. Cleaned up afterwards; gitignored regardless.
  writeFileSync(
    join(import.meta.dir, "..", "config.json"),
    JSON.stringify({ cliPath: "/bin/false" }),
    "utf8",
  );
});

afterAll(() => {
  delete process.env.CADET_WORKSPACE_DIR;
  rmSync(ws, { recursive: true, force: true });
  rmSync(join(import.meta.dir, "..", "config.json"), { force: true });
  rmSync(join(import.meta.dir, "..", "data"), { recursive: true, force: true });
});

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/webhooks/plugins/mikiedi/bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("bridge route adapter", () => {
  test("GET returns a status report", async () => {
    const res = await GET(new Request("http://localhost/x/plugins/mikiedi/bridge"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.result.plugin).toBe("mikiedi");
    expect(body.result.conceptsDir).toBe(join(ws, "memory", "concepts"));
  });

  test("malformed JSON returns 400", async () => {
    const res = await POST(
      new Request("http://localhost/x/plugins/mikiedi/bridge", {
        method: "POST",
        body: "not json",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("missing op returns 400 with the valid op list", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/'op'/);
  });

  test("publish through the HTTP adapter writes the page and reports the refresh honestly", async () => {
    const content = '---\ntitle: "Route test"\nslug: route-test\n---\n\nHello from the adapter.\n';
    const res = await post({ op: "publish", pages: [{ slug: "route-test", content }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.pages[0].status).toBe("published");
    // cliPath is /bin/false in this test: the write succeeds, the refresh
    // subprocess fails, and the bridge reports it as pending rather than hiding it.
    expect(body.result.refresh.ok).toBe(false);
    const status = await post({ op: "status" });
    const sb = (await status.json()).result;
    expect(sb.pendingRefresh).toBe(true);
  });
});
