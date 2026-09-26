import { Resolver } from "node:dns/promises";

import type { AddressResolver, ResolvedAddress } from "./contracts.js";

export interface RecursiveDnsClient {
  resolve4(host: string): Promise<readonly string[]>;
  resolve6(host: string): Promise<readonly string[]>;
}

export function createDnsAddressResolver(client: RecursiveDnsClient): AddressResolver {
  return Object.freeze({
    async resolveAll(host: string): Promise<readonly ResolvedAddress[]> {
      const [ipv4, ipv6] = await Promise.allSettled([client.resolve4(host), client.resolve6(host)]);
      if (ipv4.status === "rejected" && ipv6.status === "rejected") throw new Error("DNS_RESOLUTION_FAILED");
      const answers: ResolvedAddress[] = [];
      const seen = new Set<string>();
      const append = (values: readonly string[], family: 4 | 6): void => {
        for (const address of values) {
          const key = `${family}\0${address}`;
          if (seen.has(key)) continue;
          seen.add(key);
          answers.push(Object.freeze({ address, family }));
        }
      };
      if (ipv4.status === "fulfilled") append(ipv4.value, 4);
      if (ipv6.status === "fulfilled") append(ipv6.value, 6);
      return Object.freeze(answers);
    },
  });
}

export function createNodeDnsAddressResolver(server: string): AddressResolver {
  const client = new Resolver();
  client.setServers([server]);
  return createDnsAddressResolver(client);
}
