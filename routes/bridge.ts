/**
 * Mikiedi bridge HTTP route.
 *
 * Served at:
 *   - /x/plugins/mikiedi/bridge        (authenticated callers inside Cadet)
 *   - /webhooks/plugins/mikiedi/bridge (public ingress; the gateway verifies
 *     the bearer token declared in channels/ingress.json before forwarding)
 *
 * The route is a thin adapter: it parses JSON, builds the dependency set
 * (config, workspace dir, data dir) and delegates to the op engine in src/.
 * GET runs the status op; POST dispatches on the body's `op` field.
 */
import { handleOp, makeDeps, type BridgeDeps } from "../src/ops.ts";

const PLUGIN_ROOT = new URL("..", import.meta.url).pathname;

function deps(): BridgeDeps {
  return makeDeps(PLUGIN_ROOT);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function GET(_request: Request): Promise<Response> {
  const result = await handleOp(deps(), { op: "status" });
  return jsonResponse(result, result.ok ? 200 : 500);
}

export async function POST(request: Request): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ ok: false, error: "Mikiedi: request body must be JSON" }, 400);
  }
  if (!payload || typeof payload !== "object" || typeof payload.op !== "string") {
    return jsonResponse(
      { ok: false, error: "Mikiedi: request body must be a JSON object with an 'op' field (status, pages, page, validate, publish, delete, adopt, resolve, sync, refresh)" },
      400,
    );
  }
  const result = await handleOp(deps(), payload);
  return jsonResponse(result, result.ok ? 200 : 400);
}
