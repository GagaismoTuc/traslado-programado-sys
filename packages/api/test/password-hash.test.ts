import { argon2 } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "../src/auth.js";

describe("password hash cost", () => {
  it("asks Argon2id for the production cost m=64 MiB, t=3, p=1", async () => {
    const derive = vi.mocked(argon2);
    derive.mockClear();

    const encoded = await hashPassword("synthetic-password");

    expect(encoded).toMatch(/^\$app\$argon2id\$m=65536,t=3,p=1\$/);
    expect(await verifyPassword("synthetic-password", encoded)).toBe(true);
    expect(await verifyPassword("other-password", encoded)).toBe(false);
    expect(derive).toHaveBeenCalledTimes(3);
    for (const [algorithm, parameters] of derive.mock.calls) {
      expect(algorithm).toBe("argon2id");
      expect(parameters).toMatchObject({ memory: 65536, passes: 3, parallelism: 1, tagLength: 32 });
    }
  });
});
