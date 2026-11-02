import { BlockList, isIP } from "node:net";

const INVALID = "TRUSTED_PROXY_CIDRS must be a comma-separated list of CIDRs such as 172.16.0.0/12";

// Empty or unset trusts no proxy: the API keeps the socket address and ignores X-Forwarded-For.
export function readTrustedProxyCidrs(value: string | undefined) {
  if (!value?.trim()) return [];
  const cidrs = value.split(",").map((entry) => entry.trim());
  createTrustedProxies(cidrs);
  return cidrs;
}

export function createTrustedProxies(cidrs: string[]) {
  if (cidrs.length === 0) return null;
  const proxies = new BlockList();
  for (const cidr of cidrs) {
    const match = /^([^/]+)\/(\d{1,3})$/.exec(cidr);
    const family = match ? isIP(match[1]!) : 0;
    const prefix = Number(match?.[2]);
    if (!match || !family || prefix > (family === 4 ? 32 : 128)) throw new Error(INVALID);
    proxies.addSubnet(match[1]!, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return proxies;
}

// BlockList matches IPv4-mapped IPv6 addresses (`::ffff:172.18.0.3`) against IPv4 subnets.
function isTrustedProxy(proxies: BlockList, address: string) {
  const family = isIP(address);
  return family !== 0 && proxies.check(address, family === 4 ? "ipv4" : "ipv6");
}

// Only a trusted peer may name the client. X-Forwarded-For is walked from the right, skipping trusted proxies, so
// addresses a client prepends are never reached; anything unusable falls back to the socket address.
export function forwardedClientIp(socketAddress: string, forwardedFor: string | undefined, proxies: BlockList) {
  if (!isTrustedProxy(proxies, socketAddress)) return socketAddress;
  for (const entry of (forwardedFor ?? "").split(",").reverse()) {
    const address = entry.trim();
    if (!isIP(address)) return socketAddress;
    if (!isTrustedProxy(proxies, address)) return address;
  }
  return socketAddress;
}
