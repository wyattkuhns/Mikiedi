/**
 * Mikiedi bridge configuration.
 *
 * Optional `config.json` in the plugin root overrides defaults. The file is
 * per-install (never committed): it survives plugin upgrades and is deleted
 * on uninstall, per Cadet plugin lifecycle rules.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BridgeConfig {
  /**
   * Absolute path override for the concept-page directory.
   * Absent or empty means `<workspace>/memory/concepts`.
   */
  conceptsDir?: string;
  /** CLI binary used to trigger the retrieval-index refresh. */
  cliPath?: string;
  /** Timeout for the refresh subprocess, milliseconds. */
  refreshTimeoutMs?: number;
}

export interface ResolvedConfig {
  conceptsDir: string;
  cliPath: string;
  refreshTimeoutMs: number;
  /** True when conceptsDir was not overridden (i.e. it is the live memory store). */
  conceptsDirIsDefault: boolean;
}

export const DEFAULT_CLI_PATH = "assistant";
export const DEFAULT_REFRESH_TIMEOUT_MS = 30000;

export function loadConfig(pluginRoot: string, workspaceDir: string | null): ResolvedConfig {
  const raw: BridgeConfig = {};
  try {
    const parsed = JSON.parse(readFileSync(join(pluginRoot, "config.json"), "utf8"));
    if (parsed && typeof parsed === "object") Object.assign(raw, parsed);
  } catch {
    // No config file, or unreadable: defaults apply. Not an error.
  }

  const workspace = workspaceDir ?? process.env.CADET_WORKSPACE_DIR ?? "";
  if (!workspace) {
    throw new Error(
      "Mikiedi: cannot resolve the Cadet workspace directory. " +
        "Set CADET_WORKSPACE_DIR in the route-host environment or provide an absolute conceptsDir in config.json.",
    );
  }

  const override = raw.conceptsDir?.trim();
  return {
    conceptsDir: override ? override : join(workspace, "memory", "concepts"),
    cliPath: raw.cliPath?.trim() || DEFAULT_CLI_PATH,
    refreshTimeoutMs: raw.refreshTimeoutMs && raw.refreshTimeoutMs > 0 ? raw.refreshTimeoutMs : DEFAULT_REFRESH_TIMEOUT_MS,
    conceptsDirIsDefault: !override,
  };
}
