import { expect, it } from "vitest";
import { latestMarks, type QueuedMark } from "./offline";
import type { Mark } from "./Marks";

function queued(id: string, state: "pending" | "confirmed", note: string | null, corrects?: string): QueuedMark {
  return {
    id,
    routeId: 7,
    mark: { id, transferId: 11, phoneTime: "2026-10-23T12:00:00.000Z", kind: "subio", ...(corrects ? { corrects } : {}) } as Mark,
    state,
    confirmedAt: state === "confirmed" ? "2026-10-23T12:00:01.000Z" : null,
    note,
  };
}

it("does not let a refused pending tie outrank the only mark the API stored", () => {
  const accepted = queued("00000000-0000-4000-8000-000000000001", "confirmed", null);
  const refused = queued("ffffffff-ffff-4000-8000-000000000002", "pending", "Only the Traslado's latest Marca can be corrected", "old-mark-id");

  expect(latestMarks([accepted, refused])[11]).toBe(accepted);
});
