import ipaddr from "ipaddr.js";
import type { ResolvedAddress } from "./contracts.js";

export function normalizeAddress(address: string): ResolvedAddress {
  if (address.includes("%") || address.includes("[") || address.includes("]")) {
    throw new Error("address is not a canonical IP literal");
  }
  let parsed: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    parsed = ipaddr.process(address);
  } catch {
    throw new Error("address is not a valid IP literal");
  }
  return {
    address: parsed.toNormalizedString(),
    family: parsed.kind() === "ipv4" ? 4 : 6,
  };
}

export function assertAllAddressesPublic(addresses: readonly ResolvedAddress[]): void {
  if (addresses.length === 0) {
    throw new Error("DNS returned an empty address set");
  }
  for (const candidate of addresses) {
    const normalized = normalizeAddress(candidate.address);
    if (normalized.family !== candidate.family || ipaddr.parse(normalized.address).range() !== "unicast") {
      throw new Error("DNS answer is not a public global-unicast address");
    }
  }
}
