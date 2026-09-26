import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AcceptedProbeJob } from "../../src/wechat/callback-service.js";
import { createMyWikiWorker } from "../../src/wiki/wiki-worker.js";

function job(): AcceptedProbeJob {
  return {
    probeId: "p".repeat(32), probeHmac: "h1:" + "a".repeat(43), callbackTraceHmac: "h1:" + "b".repeat(43),
    receiptHmac: "h1:" + "c".repeat(43), senderHmac: "h1:" + "d".repeat(43), urlHmac: "h1:" + "e".repeat(43),
    eventTraceHmac: "h1:" + "f".repeat(43),
    rawUrl: "https://mp.weixin.qq.com/s/RAW_URL_SENTINEL", callbackReceivedAt: "2026-08-30T00:00:00.000Z", callbackReceivedMonoMs: 1,
  };
}

test("passes the URL only to immutable intake and gives the compiler a verified bundle identity", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "my-wiki-worker-"));
  const rawBundle = join(repoRoot, "raw", "wechat", "bundle-1");
  await mkdir(rawBundle, { recursive: true });
  const compilerInputs: unknown[] = [];
  const input = job();
  const worker = createMyWikiWorker({
    repoRoot,
    ingest: async (url, repo) => {
      assert.equal(url, input.rawUrl);
      assert.equal(repo, repoRoot);
      return { raw_bundle: rawBundle, bundle_checksum: "sha256:" + "a".repeat(64), content_checksum: "sha256:" + "b".repeat(64) };
    },
    compiler: { async compile(value) { compilerInputs.push(value); return { state: "consistent" as const }; } },
  });
  await worker.run(input);
  assert.equal(compilerInputs.length, 1);
  const serialized = JSON.stringify(compilerInputs[0]);
  assert.equal(serialized.includes("RAW_URL_SENTINEL"), false);
  assert.deepEqual(compilerInputs[0], {
    repoRoot,
    rawBundle,
    bundleChecksum: "sha256:" + "a".repeat(64),
    contentChecksum: "sha256:" + "b".repeat(64),
  });
});

test("rejects an intake result outside raw/wechat before invoking the LLM", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "my-wiki-worker-"));
  const outside = await mkdtemp(join(tmpdir(), "outside-bundle-"));
  let compiled = false;
  const worker = createMyWikiWorker({
    repoRoot,
    ingest: async () => ({ raw_bundle: outside, bundle_checksum: "sha256:" + "a".repeat(64), content_checksum: "sha256:" + "b".repeat(64) }),
    compiler: { async compile() { compiled = true; return { state: "consistent" as const }; } },
  });
  await assert.rejects(worker.run(job()), /WIKI_INGEST_RESULT_REJECTED/);
  assert.equal(compiled, false);
});
