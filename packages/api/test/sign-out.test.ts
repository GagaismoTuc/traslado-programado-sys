import { describe, expect, it } from "vitest";
import { createExecutionHarness, TODAY } from "./helpers/execution.js";
import { getSessionCookie } from "./helpers/office-session.js";

const { request, answer, rows, setup, markBody, mark } = createExecutionHarness("sign-out-test");

async function storedMarks() {
  return await rows("SELECT client_id, transfer_id, kind FROM marks ORDER BY id");
}

describe("Cerrar sesión and Revocar por pérdida o robo", () => {
  it("ends a signed-out session as expired, not revoked, so a Marca sent after it stays on the phone and is stored after signing in again", async () => {
    const { passenger, served } = await setup("logout");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    const subio = markBody(transferId, "subio");
    await answer(mark(driver.cookie, routeId, subio), 201);

    expect((await request("/auth/logout", "POST", {}, driver.cookie)).status).toBe(204);
    expect(await rows("SELECT ended_reason FROM sessions WHERE id = $1", [driver.sessionId])).toEqual([{ ended_reason: "logout" }]);
    expect(await storedMarks()).toEqual([{ client_id: subio.id, transfer_id: transferId, kind: "subio" }]);

    // The phone keeps a Marca the ended session could not send: the answer is "expired", never "revoked".
    const late = markBody(transferId, "ausente", { corrects: subio.id });
    expect(await answer(mark(driver.cookie, routeId, late), 401)).toEqual({ error: "Authentication required", code: "session_expired" });
    expect(await storedMarks()).toEqual([{ client_id: subio.id, transfer_id: transferId, kind: "subio" }]);

    const login = await request("/auth/login", "POST", { username: "chofer-logout-1", password: "chofer-logout-1-password", deviceLabel: "Celular nuevo" });
    expect(login.status).toBe(200);
    await answer(mark(getSessionCookie(login).cookie, routeId, late), 201);
    expect(await storedMarks()).toEqual([
      { client_id: subio.id, transfer_id: transferId, kind: "subio" },
      { client_id: late.id, transfer_id: transferId, kind: "ausente" },
    ]);
  });

  it("answers revoked to every request of a phone revoked for loss or theft and stores nothing it sends", async () => {
    const { office, passenger, served } = await setup("revoked");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");

    expect((await request(`/users/${driver.userId}/sessions/${driver.sessionId}`, "DELETE", undefined, office)).status).toBe(204);

    const revoked = { error: "Authentication required", code: "session_revoked" };
    expect(await answer(mark(driver.cookie, routeId, markBody(transferId, "subio")), 401)).toEqual(revoked);
    expect(await answer(request(`/driver/days/${TODAY}`, "GET", undefined, driver.cookie), 401)).toEqual(revoked);
    expect(await answer(request("/auth/me", "GET", undefined, driver.cookie), 401)).toEqual(revoked);
    expect(await storedMarks()).toEqual([]);
    expect(await rows("SELECT status FROM transfers WHERE id = $1", [transferId])).toEqual([{ status: "planificado" }]);
  });

  it("lists for the Oficina only today's Traslados of the Chofer without a confirmed Marca", async () => {
    const { office, post, passenger, chofer, route, transfer, assign, served } = await setup("unconfirmed");
    const lost = await chofer();
    const today = await route(lost.driverId);
    const tomorrow = await route(lost.driverId, "2026-10-24");
    const ids: Record<string, number> = {};
    for (const [name, time, routeId, date] of [
      ["marked", "08:00", today, TODAY], ["unmarked", "08:00", today, TODAY], ["undone", "08:00", today, TODAY],
      ["absent", "08:00", today, TODAY], ["tomorrow", "08:00", tomorrow, "2026-10-24"],
    ] as const) {
      const { passengerId } = await passenger();
      ids[name] = await transfer(passengerId, "entrada", time, date);
      await assign(ids[name], routeId);
    }
    // The order of the Paradas does not matter here.
    await post(`/routes/${today}/publish`, { overrideReason: "Orden sintético" });
    await post(`/routes/${tomorrow}/publish`, { overrideReason: "Orden sintético" });
    await answer(mark(lost.cookie, today, markBody(ids.marked, "subio")), 201);
    const undone = markBody(ids.undone, "subio");
    await answer(mark(lost.cookie, today, undone), 201);
    await answer(mark(lost.cookie, today, markBody(ids.undone, "undo", { corrects: undone.id })), 201);
    await post(`/transfers/${ids.absent}/absence`, {});
    // Another Chofer's Traslado without a Marca is not this Chofer's.
    const { passengerId: otherPassenger } = await passenger();
    await served(otherPassenger, "entrada", "09:00");

    expect((await request(`/users/${lost.userId}/sessions/${lost.sessionId}`, "DELETE", undefined, office)).status).toBe(204);
    expect(await answer(request(`/users/${lost.userId}/unconfirmed-transfers`, "GET", undefined, office), 200)).toEqual({
      date: TODAY,
      transfers: [
        { transferId: ids.unmarked, routeId: today, passengerName: "Pasajero Sintético 2", direction: "entrada", targetTime: "08:00", destinationName: "Escuela unconfirmed" },
        { transferId: ids.undone, routeId: today, passengerName: "Pasajero Sintético 3", direction: "entrada", targetTime: "08:00", destinationName: "Escuela unconfirmed" },
      ],
    });

    // Only the Oficina reads it; an Oficina account has no Traslados; an unknown user is not found.
    const other = await chofer();
    expect((await request(`/users/${lost.userId}/unconfirmed-transfers`, "GET", undefined, other.cookie)).status).toBe(403);
    expect(await answer(request("/users/1/unconfirmed-transfers", "GET", undefined, office), 200)).toEqual({ date: TODAY, transfers: [] });
    expect(await answer(request("/users/999/unconfirmed-transfers", "GET", undefined, office), 404)).toEqual({ error: "User not found" });
    expect(await answer(request("/users/3000000000/unconfirmed-transfers", "GET", undefined, office), 400)).toEqual({ error: "Invalid request" });
  });
});
