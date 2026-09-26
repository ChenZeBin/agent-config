import { homedir } from "node:os";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { buildCodexExecInvocation, createWikiCompiler, sanitizeChildEnvironment } from "../../src/wiki/wiki-compiler.js";

test("uses fresh compiler and reviewer runs, verifies consistency, then releases the exact claim", async () => {
  const rawBundle = "/repo/raw/wechat/bundle-1";
  const checksum = "sha256:" + "a".repeat(64);
  let state: "pending" | "consistent" = "pending";
  const agentCalls: Array<{ role: string; identity: string; prompt: string }> = [];
  const releases: string[] = [];
  const candidate = { raw_bundle: rawBundle, relative_manifest: "raw/wechat/bundle-1/manifest.json", bundle_checksum: checksum, state };
  const compiler = createWikiCompiler({
    repoRoot: "/repo",
    queue: {
      async scan() { return { bundles: [{ ...candidate, state }], integrity_failures: [], needs_review: [] }; },
      async claim() { return { action: "claimed", lock: { claim_id: "claim-1" }, candidate: { ...candidate, state } }; },
      async release(claimId) { releases.push(claimId); },
    },
    runAgent: async (input) => {
      agentCalls.push(input);
      if (input.role === "reviewer") state = "consistent";
    },
    newIdentity: (() => { let count = 0; return (role) => `${role}-${++count}`; })(),
  });

  const result = await compiler.compile({ repoRoot: "/repo", rawBundle, bundleChecksum: checksum, contentChecksum: "sha256:" + "b".repeat(64) });
  assert.equal(result.state, "consistent");
  assert.deepEqual(agentCalls.map((item) => item.role), ["compiler", "reviewer"]);
  assert.notEqual(agentCalls[0]?.identity, agentCalls[1]?.identity);
  assert.equal(agentCalls.every((item) => item.prompt.includes("raw/wechat/bundle-1/manifest.json")), true);
  assert.equal(agentCalls.some((item) => /https?:|openid|RAW_URL/.test(item.prompt)), false);
  assert.deepEqual(releases, ["claim-1"]);
});

test("leaves the compile lock retained when semantic review does not reach consistent", async () => {
  const checksum = "sha256:" + "a".repeat(64);
  let released = false;
  const compiler = createWikiCompiler({
    repoRoot: "/repo",
    queue: {
      async scan() { return { bundles: [{ raw_bundle: "/repo/raw/wechat/b", relative_manifest: "raw/wechat/b/manifest.json", bundle_checksum: checksum, state: "pending" }], integrity_failures: [], needs_review: [] }; },
      async claim() { return { action: "claimed", lock: { claim_id: "claim-x" }, candidate: { raw_bundle: "/repo/raw/wechat/b", relative_manifest: "raw/wechat/b/manifest.json", bundle_checksum: checksum, state: "pending" } }; },
      async release() { released = true; },
    },
    runAgent: async () => {},
  });
  await assert.rejects(compiler.compile({ repoRoot: "/repo", rawBundle: "/repo/raw/wechat/b", bundleChecksum: checksum, contentChecksum: "sha256:" + "b".repeat(64) }), /WIKI_REVIEW_INCOMPLETE/);
  assert.equal(released, false);
});

test("unrelated shared-page reviews do not block compilation or release of a verified target", async () => {
  const checksum = "sha256:" + "a".repeat(64);
  let state: "pending" | "consistent" = "pending";
  let runCount = 0;
  const releases: string[] = [];
  const candidate = { raw_bundle: "/repo/raw/wechat/target", relative_manifest: "raw/wechat/target/manifest.json", bundle_checksum: checksum, state };
  const stale = { raw_bundle: "/repo/raw/x/old", relative_manifest: "raw/x/old/manifest.json", bundle_checksum: "sha256:" + "c".repeat(64), state: "needs-review" };
  const compiler = createWikiCompiler({
    repoRoot: "/repo",
    queue: {
      async scan() { return { bundles: [{ ...candidate, state }, stale], integrity_failures: [], needs_review: [stale], blocking_needs_review: [] }; },
      async claim() { return { action: "claimed", lock: { claim_id: "target-claim" }, candidate }; },
      async release(claimId) { releases.push(claimId); },
    },
    runAgent: async (input) => { runCount += 1; if (input.role === "reviewer") state = "consistent"; },
  });
  assert.deepEqual(await compiler.compile({ repoRoot: "/repo", rawBundle: candidate.raw_bundle, bundleChecksum: checksum, contentChecksum: checksum }), { state: "consistent" });
  assert.equal(runCount, 2);
  assert.deepEqual(releases, ["target-claim"]);
});

test("an isolated review target is not silently treated as pending or compiled", async () => {
  const checksum = "sha256:" + "a".repeat(64);
  const candidate = { raw_bundle: "/repo/raw/wechat/target", relative_manifest: "raw/wechat/target/manifest.json", bundle_checksum: checksum, state: "needs-review" };
  const compiler = createWikiCompiler({
    repoRoot: "/repo",
    queue: {
      async scan() { return { bundles: [candidate], integrity_failures: [], needs_review: [candidate], blocking_needs_review: [] }; },
      async claim() { assert.fail("must not claim an unrelated bundle for a review-only target"); },
      async release() { assert.fail("must not release a claim"); },
    },
    runAgent: async () => { assert.fail("must not compile a review-only target"); },
  });
  await assert.rejects(compiler.compile({ repoRoot: "/repo", rawBundle: candidate.raw_bundle, bundleChecksum: checksum, contentChecksum: checksum }), /WIKI_REVIEW_INCOMPLETE/);
});

test("raw failures, blocking reviews and legacy unclassified reviews still fail closed", async () => {
  const checksum = "sha256:" + "a".repeat(64);
  const candidate = { raw_bundle: "/repo/raw/wechat/target", relative_manifest: "raw/wechat/target/manifest.json", bundle_checksum: checksum, state: "pending" };
  const defect = { state: "needs-review" };
  for (const scan of [
    { integrity_failures: [{ error: "tampered raw" }], needs_review: [defect], blocking_needs_review: [] },
    { integrity_failures: [], needs_review: [defect], blocking_needs_review: [defect] },
    { integrity_failures: [], needs_review: [defect] },
  ]) {
    const compiler = createWikiCompiler({
      repoRoot: "/repo",
      queue: {
        async scan() { return { bundles: [candidate], ...scan }; },
        async claim() { assert.fail("unsafe queues must not be claimed"); },
        async release() { assert.fail("unsafe queues must not be released"); },
      },
      runAgent: async () => { assert.fail("unsafe queues must not run agents"); },
    });
    await assert.rejects(compiler.compile({ repoRoot: "/repo", rawBundle: candidate.raw_bundle, bundleChecksum: checksum, contentChecksum: checksum }), /WIKI_QUEUE_UNSAFE/);
  }
});

test("Codex invocation is fixed to the approved model and strips webhook secrets", () => {
  assert.deepEqual(buildCodexExecInvocation("/repo"), {
    command: resolve(homedir(), ".local/bin/codex"),
    args: ["exec", "--ephemeral", "--ignore-user-config", "-s", "workspace-write", "-C", "/repo", "-m", "gpt-5.6-sol", "-c", "model_reasoning_effort=max", "-"],
  });
  const clean = sanitizeChildEnvironment({ PATH: "/bin", HOME: "/home/user", WECHAT_TOKEN: "secret", WEBHOOK_HMAC_KEY: "secret", OPENAI_API_KEY: "secret", PUBLIC_BASE_URL: "secret", AWS_SECRET_ACCESS_KEY: "secret" });
  assert.deepEqual(clean, { PATH: "/bin", HOME: "/home/user" });
});
