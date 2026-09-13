/**
 * Tests for CHP policy loading (src/chp/policy.ts)
 *
 * Proves: policy files are only read when the resolved path stays under the
 * allowed base (`<cwd>/config` by default). Traversal and absolute paths
 * outside that base are rejected before any readFileSync.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  defaultPolicy,
  defaultPolicyBase,
  defaultPolicyPath,
  loadPolicy,
  resolvePolicyPath,
} from "../src/chp/policy";

test("default policy path resolves under cwd/config", () => {
  const base = defaultPolicyBase();
  const path = defaultPolicyPath();
  assert.equal(base, resolve(process.cwd(), "config"));
  assert.equal(path, resolve(base, "policy.yaml"));
});

test("loads a policy file that stays under the allowed base", () => {
  const policy = loadPolicy("policy.yaml");
  // version "1.0" in YAML is parsed as a number, so the string fallback applies;
  // notional/HITL fields prove the on-disk file was read.
  assert.equal(policy.maxNotionalUsd, 10000);
  assert.equal(policy.hitlThresholdUsd, 3000);
  assert.equal(policy.perAssetLimits.SUI, 8000);
});

test("accepts the default absolute policy path", () => {
  const policy = loadPolicy(defaultPolicyPath());
  assert.equal(policy.maxNotionalUsd, 10000);
  assert.equal(policy.dailyNotionalCapUsd, 50000);
});

test("reads a policy from a caller-supplied allowed base", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vm-policy-base-"));
  try {
    writeFileSync(
      join(tmp, "policy.yaml"),
      ["version: custom-base", "max_notional_usd: 42"].join("\n"),
    );
    const policy = loadPolicy("policy.yaml", tmp);
    assert.equal(policy.version, "custom-base");
    assert.equal(policy.maxNotionalUsd, 42);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resolvePolicyPath rejects traversal and off-base absolute paths", () => {
  assert.throws(() => resolvePolicyPath("../package.json"), /outside allowed base/);
  assert.throws(() => resolvePolicyPath("../../../../etc/passwd"), /outside allowed base/);
  assert.throws(() => resolvePolicyPath("/etc/passwd"), /outside allowed base/);
  assert.throws(() => resolvePolicyPath("..\\..\\etc\\passwd"), /outside allowed base/);
  assert.doesNotThrow(() => resolvePolicyPath("policy.yaml"));
  assert.doesNotThrow(() => resolvePolicyPath(defaultPolicyPath()));
  // In-tree collapse of `..` stays under the allowed base.
  assert.equal(
    resolvePolicyPath("subdir/../policy.yaml"),
    resolve(defaultPolicyBase(), "policy.yaml"),
  );
});

test("rejects path traversal and does not read files outside the allowed base", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vm-policy-"));
  try {
    const bait = join(tmp, "secrets.yaml");
    writeFileSync(
      bait,
      ["version: \"pwned\"", "max_notional_usd: 1", "min_confidence: 0.01"].join("\n"),
    );
    const fromAbsolute = loadPolicy(bait);
    assert.equal(fromAbsolute.version, "1.0-default");
    assert.deepEqual(fromAbsolute, defaultPolicy());

    const fromTraversal = loadPolicy("../package.json");
    assert.equal(fromTraversal.version, "1.0-default");

    const fromEtc = loadPolicy("/etc/passwd");
    assert.equal(fromEtc.version, "1.0-default");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("accepts a nested path and in-tree `..` collapse under the allowed base", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vm-policy-nested-"));
  try {
    mkdirSync(join(tmp, "team"));
    writeFileSync(
      join(tmp, "team", "policy.yaml"),
      ["version: nested", "max_notional_usd: 7"].join("\n"),
    );
    writeFileSync(
      join(tmp, "policy.yaml"),
      ["version: collapsed", "max_notional_usd: 9"].join("\n"),
    );
    const nested = loadPolicy("team/policy.yaml", tmp);
    assert.equal(nested.version, "nested");
    assert.equal(nested.maxNotionalUsd, 7);

    const collapsed = loadPolicy("team/../policy.yaml", tmp);
    assert.equal(collapsed.version, "collapsed");
    assert.equal(collapsed.maxNotionalUsd, 9);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("rejects a symlink that escapes the allowed base", () => {
  const tmp = mkdtempSync(join(tmpdir(), "vm-policy-symlink-"));
  try {
    const outside = join(tmp, "secrets.yaml");
    writeFileSync(
      outside,
      ["version: \"pwned\"", "max_notional_usd: 1"].join("\n"),
    );
    const base = join(tmp, "config");
    mkdirSync(base);
    symlinkSync(outside, join(base, "policy.yaml"));
    const policy = loadPolicy("policy.yaml", base);
    assert.deepEqual(policy, defaultPolicy());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
