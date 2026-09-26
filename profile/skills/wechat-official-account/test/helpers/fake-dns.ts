import type { AddressResolver, ResolvedAddress } from "../../src/article/contracts.js";

export class FakeDns implements AddressResolver {
  readonly calls: string[] = [];

  constructor(private readonly answers: ReadonlyMap<string, readonly ResolvedAddress[]>) {}

  async resolveAll(host: string): Promise<readonly ResolvedAddress[]> {
    this.calls.push(host);
    return this.answers.get(host) ?? [];
  }
}
