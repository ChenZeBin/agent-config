import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import type { AcceptedProbeJob } from "../wechat/callback-service.js";

const CHECKSUM = /^sha256:[a-f0-9]{64}$/;

export interface WikiCompileInput {
  readonly repoRoot: string;
  readonly rawBundle: string;
  readonly bundleChecksum: string;
  readonly contentChecksum: string;
}
export interface WikiCompilerPort { compile(input: WikiCompileInput): Promise<{ readonly state: "consistent" }>; }
export type MyWikiIngestPort = (url: string, repoRoot: string) => Promise<{
  readonly raw_bundle: string;
  readonly bundle_checksum: string;
  readonly content_checksum: string;
}>;

async function verifiedBundle(repoRoot: string, value: string): Promise<string> {
  const rawRoot = join(repoRoot, "raw", "wechat");
  const candidate = resolve(value);
  const stat = await lstat(candidate).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || dirname(candidate) !== rawRoot) throw new Error("WIKI_INGEST_RESULT_REJECTED");
  const [realRoot, realCandidate] = await Promise.all([realpath(rawRoot), realpath(candidate)]);
  if (dirname(realCandidate) !== realRoot || realCandidate !== join(realRoot, basename(candidate))) throw new Error("WIKI_INGEST_RESULT_REJECTED");
  return candidate;
}

export function createMyWikiWorker(options: {
  readonly repoRoot: string;
  readonly ingest: MyWikiIngestPort;
  readonly compiler: WikiCompilerPort;
}): { run(job: AcceptedProbeJob): Promise<void> } {
  const repoRoot = resolve(options.repoRoot);
  return {
    async run(job) {
      const ingested = await options.ingest(job.rawUrl, repoRoot);
      if (!CHECKSUM.test(ingested.bundle_checksum) || !CHECKSUM.test(ingested.content_checksum)) throw new Error("WIKI_INGEST_RESULT_REJECTED");
      const rawBundle = await verifiedBundle(repoRoot, ingested.raw_bundle);
      const result = await options.compiler.compile({
        repoRoot,
        rawBundle,
        bundleChecksum: ingested.bundle_checksum,
        contentChecksum: ingested.content_checksum,
      });
      if (result.state !== "consistent") throw new Error("WIKI_COMPILE_INCOMPLETE");
    },
  };
}
