import { BlockList, isIP } from "node:net";

const INVALID = "TRUSTED_PROXY_CIDRS must be a comma-separated list of CIDRs such as 172.16.0.0/12 or single addresses such as 172.18.0.2";
const TRUSTS_EVERYONE = "TRUSTED_PROXY_CIDRS must not trust every address (a /0 such as 0.0.0.0/0 or ::/0)";

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
    // A single address without a suffix is that address alone: a /32 or a /128.
    const match = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(cidr);
    const family = match ? isIP(match[1]!) : 0;
    const prefix = match?.[2] === undefined ? (family === 4 ? 32 : 128) : Number(match[2]);
    if (!match || !family || prefix > (family === 4 ? 32 : 128)) throw new Error(INVALID);
    // A /0 would let any client name its own address and dodge the login limiter.
    if (prefix === 0) throw new Error(TRUSTS_EVERYONE);
    proxies.addSubnet(match[1]!, prefix, family === 4 ? "ipv4" : "ipv6");
  }
  return proxies;
}

// One client has several spellings (`2001:0DB8::1` and `2001:db8::1`, `::ffff:203.0.113.5` and `203.0.113.5`): the
// limiter key uses one. IPv6 is serialized as the URL standard does (RFC 5952) and an IPv4-mapped address as its IPv4
// address. Anything that is not an address, such as `unknown`, is returned as is.
export function canonicalIp(address: string) {
  const [ip, zone] = address.split("%", 2);
  if (isIP(address) !== 6) return address;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (mapped) {
    const value = (parseInt(mapped[1]!, 16) << 16 | parseInt(mapped[2]!, 16)) >>> 0;
    return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
  }
  return zone === undefined ? canonical : `${canonical}%${zone}`;
}

// BlockList matches IPv4-mapped IPv6 addresses (`::ffff:172.18.0.3`) against IPv4 subnets.
function isTrustedProxy(proxies: BlockList, address: string) {
  const family = isIP(address);
  return family !== 0 && proxies.check(address, family === 4 ? "ipv4" : "ipv6");
}

// Only a trusted peer may name the client. X-Forwarded-For is walked from the right, skipping trusted proxies, so
// addresses a client prepends are never reached. A header with any malformed entry is unusable as a whole and, like a
// missing one, falls back to the socket address.
export function forwardedClientIp(socketAddress: string, forwardedFor: string | undefined, proxies: BlockList) {
  if (!isTrustedProxy(proxies, socketAddress)) return socketAddress;
  const addresses = (forwardedFor ?? "").split(",").map((entry) => entry.trim());
  if (!addresses.every((address) => isIP(address))) return socketAddress;
  return addresses.reverse().find((address) => !isTrustedProxy(proxies, address)) ?? socketAddress;
}
