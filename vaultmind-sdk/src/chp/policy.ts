/**
 * VaultMind SDK — CHP Risk Policy loader
 *
 * Mirrors the donor `cm-policy` / `sfe-policy` YAML policy engine: load a flat
 * policy YAML, fall back to a conservative default if the file is missing or
 * unparseable. No external YAML dependency is added — the policy schema is flat
 * (scalars + a simple string list + a numeric map), so a tiny purpose-built
 * parser keeps the change additive and dependency-free.
 */

import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type ChpAction = "buy" | "sell" | "rebalance";

export interface RiskPolicy {
  version: string;
  /** Hard ceiling per single action (USD-equivalent). Above => BLOCK. */
  maxNotionalUsd: number;
  /** Rolling daily cumulative notional cap. */
  dailyNotionalCapUsd: number;
  /** HITL threshold. At/above => human approval required. */
  hitlThresholdUsd: number;
  /** Actions the agent may take at all. */
  allowedActions: ChpAction[];
  /** Per-token notional caps keyed by symbol. */
  perAssetLimits: Record<string, number>;
  /** Minimum signal confidence (0..1). */
  minConfidence: number;
}

/** Conservative built-in fallback used when the policy file is absent. */
export function defaultPolicy(): RiskPolicy {
  return {
    version: "1.0-default",
    maxNotionalUsd: 2000.0,
    dailyNotionalCapUsd: 10000.0,
    hitlThresholdUsd: 1000.0,
    allowedActions: ["buy", "sell", "rebalance"],
    perAssetLimits: {},
    minConfidence: 0.55,
  };
}

/** Allowed root for policy files (`<cwd>/config`). */
export function defaultPolicyBase(): string {
  return resolve(process.cwd(), "config");
}

/** Default location of the policy file (config/policy.yaml under cwd). */
export function defaultPolicyPath(): string {
  return resolve(defaultPolicyBase(), "policy.yaml");
}

function isPathInsideBase(resolvedPath: string, resolvedBase: string): boolean {
  const rel = relative(resolvedBase, resolvedPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return false;
  }
  // Prefix check is SAST-friendly and blocks `/base` vs `/base-evil` collisions.
  return resolvedPath.startsWith(resolvedBase + sep);
}

/**
 * Resolve `policyPath` under `allowedBase` (default: `<cwd>/config`) and reject
 * path traversal or any path that escapes that base before a file is read.
 */
export function resolvePolicyPath(
  policyPath: string,
  allowedBase: string = defaultPolicyBase(),
): string {
  const resolvedBase = resolve(allowedBase);
  const resolvedPath = isAbsolute(policyPath)
    ? resolve(policyPath)
    : resolve(resolvedBase, policyPath);

  if (!isPathInsideBase(resolvedPath, resolvedBase)) {
    throw new Error(
      `Rejected policy path outside allowed base ${resolvedBase}: ${policyPath}`,
    );
  }
  return resolvedPath;
}

/**
 * Load a risk policy from a flat YAML file. Returns a conservative default (and
 * logs a warning) if the file is missing, escapes the allowed base, or cannot
 * be parsed — non-breaking. The resolved path is constrained to
 * `<cwd>/config` (or a caller-supplied base) before any filesystem read.
 */
export function loadPolicy(
  policyPath: string = defaultPolicyPath(),
  allowedBase: string = defaultPolicyBase(),
): RiskPolicy {
  let safePath: string;
  try {
    safePath = resolvePolicyPath(policyPath, allowedBase);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CHP] ${msg} — using conservative default policy`);
    return defaultPolicy();
  }
  if (!existsSync(safePath)) {
    console.warn(
      `[CHP] policy file not found at ${safePath} — using conservative default policy`,
    );
    return defaultPolicy();
  }
  try {
    const raw = readFileSync(safePath, "utf8");
    return coercePolicy(parseFlatYaml(raw));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[CHP] failed to parse policy ${safePath} (${msg}) — using default policy`);
    return defaultPolicy();
  }
}

/* ─── Minimal flat-YAML parser ──────────────────────────────────────────────
 * Supports `key: value` scalars, a top-level `key:` followed by indented
 * `- item` list entries, and a top-level `key:` followed by indented
 * `subkey: value` numeric maps (or inline `{}`). Comments and blanks ignored.
 */
type YamlValue = string | number | boolean | string[] | Record<string, number>;

function parseFlatYaml(text: string): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = stripComment(lines[i]);
    if (line.trim() === "") { i++; continue; }
    const m = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line);
    if (!m) { i++; continue; }
    const key = m[1];
    const inline = m[2].trim();
    if (inline !== "" && inline !== "{}") {
      out[key] = parseScalar(inline);
      i++;
      continue;
    }
    if (inline === "{}") {
      out[key] = {};
      i++;
      continue;
    }
    const list: string[] = [];
    const map: Record<string, number> = {};
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j])) {
      const t = stripComment(lines[j]).trim();
      j++;
      if (t === "") continue;
      if (t.startsWith("- ")) {
        list.push(stripQuotes(t.slice(2).trim()));
      } else {
        const cm = /^(.+?):\s*(.*)$/.exec(t);
        if (cm) map[stripQuotes(cm[1].trim())] = Number(cm[2].trim());
      }
    }
    out[key] = list.length > 0 ? list : map;
    i = j;
  }
  return out;
}

function stripComment(line: string): string {
  const idx = line.indexOf("#");
  return idx === -1 ? line : line.slice(0, idx);
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, "");
}

function parseScalar(s: string): string | number | boolean {
  const v = stripQuotes(s);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v !== "" && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

function coercePolicy(p: Record<string, YamlValue>): RiskPolicy {
  const d = defaultPolicy();
  const num = (k: string, fallback: number): number =>
    typeof p[k] === "number" ? (p[k] as number) : fallback;
  const actions = Array.isArray(p["allowed_actions"])
    ? (p["allowed_actions"] as string[]).map((a) => a as ChpAction)
    : d.allowedActions;
  const perAsset = p["per_asset_limits"] && !Array.isArray(p["per_asset_limits"])
    ? (p["per_asset_limits"] as Record<string, number>)
    : {};
  return {
    version: typeof p["version"] === "string" ? (p["version"] as string) : d.version,
    maxNotionalUsd: num("max_notional_usd", d.maxNotionalUsd),
    dailyNotionalCapUsd: num("daily_notional_cap_usd", d.dailyNotionalCapUsd),
    hitlThresholdUsd: num("hitl_threshold_usd", d.hitlThresholdUsd),
    allowedActions: actions,
    perAssetLimits: perAsset,
    minConfidence: num("min_confidence", d.minConfidence),
  };
}
