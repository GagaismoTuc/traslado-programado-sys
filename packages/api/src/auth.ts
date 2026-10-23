import { createHash, randomBytes, timingSafeEqual, argon2 } from "node:crypto";

const ARGON_OPTIONS = { parallelism: 1, tagLength: 32, memory: 65536, passes: 3 } as const;

function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    argon2("argon2id", { ...ARGON_OPTIONS, message: password, nonce: salt }, (error, digest) => {
      if (error) reject(error);
      else resolve(digest);
    });
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const digest = await derive(password, salt);
  return `$app$argon2id$m=65536,t=3,p=1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const match = /^\$app\$argon2id\$m=65536,t=3,p=1\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(encoded);
  if (!match) return false;
  const salt = Buffer.from(match[1], "base64url");
  const expected = Buffer.from(match[2], "base64url");
  if (salt.length !== 16 || expected.length !== ARGON_OPTIONS.tagLength) return false;
  const actual = await derive(password, salt);
  return timingSafeEqual(actual, expected);
}

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function normalizeUsername(username: string) {
  return username.trim().toLocaleLowerCase("en-US");
}
