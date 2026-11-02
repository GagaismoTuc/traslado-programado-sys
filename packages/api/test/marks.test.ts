import { describe, expect, it } from "vitest";
import { createExecutionHarness, HOME, NOW, TODAY, YESTERDAY } from "./helpers/execution.js";

const { appPool, clock, request, answer, rows, setup, markBody, mark } = createExecutionHarness("marks-test", {
  baseAddress: "Base Sintética, Calle Inventada 999",
});

async function marks() {
  return await rows("SELECT * FROM marks ORDER BY id");
}

async function alerts() {
  return (await rows("SELECT kind, transfer_id, route_id, mark_id, details FROM alerts ORDER BY id")).map((row) => ({
    kind: row.kind, transferId: row.transfer_id, routeId: row.route_id, markId: row.mark_id, details: row.details,
  }));
}

async function transferStatus(transferId: number) {
  return (await rows("SELECT status FROM transfers WHERE id = $1", [transferId]))[0].status;
}

async function routeStatus(routeId: number) {
  return (await rows("SELECT status FROM routes WHERE id = $1", [routeId]))[0].status;
}

describe("Starting a Recorrido", () => {
  it("moves a published Recorrido to En curso when the Chofer starts it or makes its first Marca", async () => {
    const { passenger, served } = await setup("start");
    const { passengerId } = await passenger();
    const first = await served(passengerId, "entrada");
    expect(await routeStatus(first.routeId)).toBe("publicado");
    expect(await answer(request(`/driver/routes/${first.routeId}/start`, "POST", {}, first.driver.cookie), 200))
      .toEqual({ route: { routeId: first.routeId, status: "en_curso" } });
    expect(await routeStatus(first.routeId)).toBe("en_curso");
    // Starting it again changes nothing and logs nothing.
    await answer(request(`/driver/routes/${first.routeId}/start`, "POST", {}, first.driver.cookie), 200);
    expect(await rows("SELECT actor_user_id, action, before_data, after_data FROM change_log WHERE entity = 'route' AND action = 'started'")).toEqual([
      { actor_user_id: first.driver.userId, action: "started", before_data: { status: "publicado" }, after_data: { status: "en_curso" } },
    ]);

    const second = await served(passengerId, "salida");
    await answer(mark(second.driver.cookie, second.routeId, markBody(second.transferId, "subio")), 201);
    expect(await routeStatus(second.routeId)).toBe("en_curso");

    expect(await answer(request(`/driver/routes/${first.routeId}/start`, "POST", {}, second.driver.cookie), 403))
      .toEqual({ error: "This Recorrido belongs to another Chofer" });
  });

  it("refuses to start a Recorrido that was never published", async () => {
    const { chofer, route } = await setup("draft");
    const driver = await chofer();
    const routeId = await route(driver.driverId);
    expect(await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 409))
      .toEqual({ error: "A Recorrido can be started once it is published" });
    expect(await routeStatus(routeId)).toBe("borrador");
  });
});

describe("Marcas", () => {
  it("stores Subió, Ausente and Entregado with the UUID, phone and server times, location, the version seen and the author session", async () => {
    const { passenger, served, school } = await setup("store");
    const { passengerId } = await passenger();
    const entrada = await served(passengerId, "entrada");
    const absent = await served(passengerId, "salida");
    const phoneTime = "2026-10-23T11:58:30.000Z";
    const subio = markBody(entrada.transferId, "subio", { phoneTime });
    clock.now = new Date("2026-10-23T12:00:05.000Z");
    expect(await answer(mark(entrada.driver.cookie, entrada.routeId, subio), 201)).toEqual({
      mark: {
        id: subio.id, transferId: entrada.transferId, routeId: entrada.routeId, version: 1, kind: "subio", phoneTime,
        serverTime: "2026-10-23T12:00:05.000Z", location: HOME, receiver: null, flags: [],
      },
    });
    expect(await transferStatus(entrada.transferId)).toBe("subio");
    const entregado = markBody(entrada.transferId, "entregado", { location: null, receiver: { kind: "destination", destinationId: school } });
    expect((await answer(mark(entrada.driver.cookie, entrada.routeId, entregado), 201)).mark.receiver).toEqual({ kind: "destination", destinationId: school });
    expect(await transferStatus(entrada.transferId)).toBe("entregado");
    await answer(mark(absent.driver.cookie, absent.routeId, markBody(absent.transferId, "ausente")), 201);
    expect(await transferStatus(absent.transferId)).toBe("ausente");

    const version = (await rows("SELECT id FROM plan_versions WHERE route_id = $1 AND version = 1", [entrada.routeId]))[0].id;
    expect((await marks()).map((row) => ({
      clientId: row.client_id, kind: row.kind, phoneTime: row.phone_time.toISOString(), serverTime: row.server_time.toISOString(),
      location: row.latitude === null ? null : [row.latitude, row.longitude], planVersionId: row.plan_version_id, sessionId: row.session_id,
    }))).toEqual([
      { clientId: subio.id, kind: "subio", phoneTime, serverTime: "2026-10-23T12:00:05.000Z", location: [HOME.lat, HOME.lng], planVersionId: version, sessionId: entrada.driver.sessionId },
      { clientId: entregado.id, kind: "entregado", phoneTime: "2026-10-23T12:00:05.000Z", serverTime: "2026-10-23T12:00:05.000Z", location: null, planVersionId: version, sessionId: entrada.driver.sessionId },
      { clientId: expect.any(String), kind: "ausente", phoneTime: "2026-10-23T12:00:05.000Z", serverTime: "2026-10-23T12:00:05.000Z", location: [HOME.lat, HOME.lng], planVersionId: expect.any(Number), sessionId: absent.driver.sessionId },
    ]);
  });

  it("never lets the application role update or delete a Marca", async () => {
    const { passenger, served } = await setup("append");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    await answer(mark(driver.cookie, routeId, markBody(transferId, "subio")), 201);
    await expect(appPool.query("UPDATE marks SET kind = 'ausente'")).rejects.toThrow(/permission denied/i);
    await expect(appPool.query("DELETE FROM marks")).rejects.toThrow(/permission denied/i);
    expect((await marks()).map((row) => row.kind)).toEqual(["subio"]);
  });

  it("returns the stored Marca for a resent UUID and keeps the first one with one conflict alert when the content differs", async () => {
    const { passenger, served } = await setup("resend");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    const body = markBody(transferId, "subio");
    const stored = await answer(mark(driver.cookie, routeId, body), 201);
    clock.now = new Date("2026-10-23T12:03:00.000Z");
    expect(await answer(mark(driver.cookie, routeId, body), 200)).toEqual(stored);

    const different = { ...body, kind: "ausente" };
    expect(await answer(mark(driver.cookie, routeId, different), 200)).toEqual({ ...stored, conflict: true });
    expect(await answer(mark(driver.cookie, routeId, different), 200)).toEqual({ ...stored, conflict: true });
    expect((await marks()).map((row) => [row.client_id, row.kind])).toEqual([[body.id, "subio"]]);
    expect(await transferStatus(transferId)).toBe("subio");
    const markId = (await marks())[0].id;
    expect(await alerts()).toEqual([{
      kind: "mark_conflict", transferId, routeId, markId,
      details: { sent: { transferId, kind: "ausente", phoneTime: NOW, location: HOME, version: 1, receiver: null, routeId } },
    }]);
  });

  it("refuses an Entregado without a Receptor and stores nothing", async () => {
    const { passenger, served } = await setup("receptor");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "salida");
    for (const receiver of [undefined, null]) {
      expect(await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", { receiver })), 400))
        .toEqual({ error: "Entregado requires a Receptor" });
    }
    for (const receiver of [{}, { kind: "other_adult", name: "Tía Sintética" }, { kind: "authorized_adult" }, { kind: "nobody" }]) {
      expect(await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", { receiver })), 400), JSON.stringify(receiver))
        .toEqual({ error: "Invalid request" });
    }
    expect(await answer(mark(driver.cookie, routeId, markBody(transferId, "subio", { receiver: { kind: "base_staff" } })), 400))
      .toEqual({ error: "Invalid request" });
    expect(await marks()).toEqual([]);
    expect(await alerts()).toEqual([]);
    expect(await transferStatus(transferId)).toBe("planificado");
    expect(await routeStatus(routeId)).toBe("publicado");
  });

  it("accepts and flags a Marca for a Traslado the Oficina moved, and a late one", async () => {
    const { passenger, served, chofer, route, assign } = await setup("moved");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    // While the phone still shows version 1, the Oficina moves the Traslado to another Chofer's Recorrido.
    const other = await chofer();
    await assign(transferId, await route(other.driverId));
    const moved = await answer(mark(driver.cookie, routeId, markBody(transferId, "subio")), 201);
    expect(moved.mark.flags).toEqual(["transfer_moved"]);
    expect(await transferStatus(transferId)).toBe("subio");
    expect(await alerts()).toEqual([
      { kind: "mark_flagged", transferId, routeId, markId: (await marks())[0].id, details: { reasons: ["transfer_moved"] } },
    ]);

    // Yesterday's Recorrido, sent a day late from a phone that was off: still stored, without a flag.
    const late = await served(passengerId, "salida", "13:00", YESTERDAY);
    const phoneTime = "2026-10-22T16:10:00.000Z";
    expect((await answer(mark(late.driver.cookie, late.routeId, markBody(late.transferId, "subio", { phoneTime })), 201)).mark)
      .toMatchObject({ phoneTime, flags: [] });
  });

  it("keeps the Traslado on its newest Marca when an older one arrives later", async () => {
    const { passenger, served, school } = await setup("order");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", { receiver: { kind: "destination", destinationId: school } })), 201);
    await answer(mark(driver.cookie, routeId, markBody(transferId, "subio", { phoneTime: "2026-10-23T11:40:00.000Z" })), 201);
    expect(await transferStatus(transferId)).toBe("entregado");
  });

  it("refuses a Marca for a Traslado the Chofer was never given, or for another Chofer's Recorrido", async () => {
    const { passenger, served } = await setup("scope");
    const { passengerId } = await passenger();
    const mine = await served(passengerId, "entrada");
    const theirs = await served(passengerId, "salida");
    expect(await answer(mark(mine.driver.cookie, mine.routeId, markBody(theirs.transferId, "subio")), 404))
      .toEqual({ error: "Traslado not found in this Versión del plan" });
    expect(await answer(mark(mine.driver.cookie, mine.routeId, markBody(mine.transferId, "subio", { version: 2 })), 404))
      .toEqual({ error: "Versión del plan not found" });
    expect(await answer(mark(mine.driver.cookie, theirs.routeId, markBody(theirs.transferId, "subio")), 403))
      .toEqual({ error: "This Recorrido belongs to another Chofer" });
    // A UUID another Chofer already used is neither returned nor compared.
    const theirMark = markBody(theirs.transferId, "entregado", { receiver: { kind: "other_adult", name: "Tía Sintética", dni: "-3000001" } });
    await answer(mark(theirs.driver.cookie, theirs.routeId, theirMark), 201);
    expect(await answer(mark(mine.driver.cookie, mine.routeId, { ...theirMark, transferId: mine.transferId, kind: "subio", receiver: undefined }), 409))
      .toEqual({ error: "This Marca belongs to another Chofer" });
    expect((await alerts()).map((alert) => alert.kind)).toEqual(["other_adult_handover", "mark_flagged"]);
    for (const body of [
      markBody(mine.transferId, "subio", { id: "not-a-uuid" }),
      markBody(mine.transferId, "subio", { phoneTime: "2026-10-23 09:00" }),
      markBody(mine.transferId, "subio", { location: { lat: 91, lng: 0 } }),
      markBody(mine.transferId, "subio", { kind: "llego" }),
    ]) {
      expect(await answer(mark(mine.driver.cookie, mine.routeId, body), 400), JSON.stringify(body)).toEqual({ error: "Invalid request" });
    }
    expect((await marks()).map((row) => row.client_id)).toEqual([theirMark.id]);
  });
});

describe("Receptor and the Consentimiento", () => {
  it("raises an alert for every other-adult handover and accepts and flags a Receptor the current Consentimiento does not allow", async () => {
    const { passenger, served, office } = await setup("other");
    const allowing = await passenger(true);
    const allowed = await served(allowing.passengerId, "salida");
    const handedOver = { kind: "other_adult", name: "Tía Sintética", dni: "-3000001" };
    expect((await answer(mark(allowed.driver.cookie, allowed.routeId, markBody(allowed.transferId, "entregado", { receiver: handedOver })), 201)).mark)
      .toMatchObject({ receiver: { ...handedOver, authorizationId: null }, flags: [] });

    const forbidding = await passenger(false);
    const forbidden = await served(forbidding.passengerId, "salida");
    expect((await answer(mark(forbidden.driver.cookie, forbidden.routeId, markBody(forbidden.transferId, "entregado", { receiver: handedOver })), 201)).mark.flags)
      .toEqual(["consent_mismatch"]);
    expect(await transferStatus(forbidden.transferId)).toBe("entregado");

    // An Adulto autorizado the Oficina removed no longer matches the Consentimiento's list.
    const removed = await served(forbidding.passengerId, "salida", "15:00");
    expect((await request(`/authorized-adults/${forbidding.neighbour}`, "DELETE", undefined, office)).status).toBe(204);
    const receiver = { kind: "authorized_adult", adultId: forbidding.neighbour };
    expect((await answer(mark(removed.driver.cookie, removed.routeId, markBody(removed.transferId, "entregado", { receiver })), 201)).mark.flags)
      .toEqual(["consent_mismatch"]);
    const kept = await served(forbidding.passengerId, "salida", "16:00");
    expect((await answer(mark(kept.driver.cookie, kept.routeId, markBody(kept.transferId, "entregado", {
      receiver: { kind: "authorized_adult", adultId: forbidding.guardian },
    })), 201)).mark.flags).toEqual([]);

    const ids = (await marks()).map((row) => row.id);
    expect(await alerts()).toEqual([
      { kind: "other_adult_handover", transferId: allowed.transferId, routeId: allowed.routeId, markId: ids[0], details: { authorized: false, name: "Tía Sintética", dni: "-3000001" } },
      { kind: "other_adult_handover", transferId: forbidden.transferId, routeId: forbidden.routeId, markId: ids[1], details: { authorized: false, name: "Tía Sintética", dni: "-3000001" } },
      { kind: "mark_flagged", transferId: forbidden.transferId, routeId: forbidden.routeId, markId: ids[1], details: { reasons: ["consent_mismatch"] } },
      { kind: "mark_flagged", transferId: removed.transferId, routeId: removed.routeId, markId: ids[2], details: { reasons: ["consent_mismatch"] } },
    ]);
    expect((await rows("SELECT removed_at FROM authorized_adults WHERE id = $1", [forbidding.neighbour]))[0].removed_at).not.toBeNull();
  });

  it("records an Entregado to company staff at the base, which leaves the Traslado Entregado so its Recorrido can close", async () => {
    const { passenger, served } = await setup("base");
    const { passengerId } = await passenger(false);
    const { driver, routeId, transferId } = await served(passengerId, "salida");
    expect((await answer(request(`/driver/routes/${routeId}/transfers/${transferId}/handover`, "GET", undefined, driver.cookie), 200)).base)
      .toEqual({ address: "Base Sintética, Calle Inventada 999" });
    await answer(mark(driver.cookie, routeId, markBody(transferId, "subio")), 201);
    expect((await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", { receiver: { kind: "base_staff" } })), 201)).mark)
      .toMatchObject({ receiver: { kind: "base_staff" }, flags: [] });
    expect(await transferStatus(transferId)).toBe("entregado");
    expect(await alerts()).toEqual([]);
  });
});

describe("Ausente on an entrada", () => {
  it("lists the Pasajero's remaining Traslados of the day in the inbox and cancels none of them", async () => {
    const { passenger, served, transfer, post, therapy } = await setup("absent");
    const { passengerId } = await passenger();
    const other = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada", "08:00");
    const salida = await transfer(passengerId, "salida", "13:00");
    const fromTherapy = await transfer(passengerId, "entrada", "11:00", TODAY, therapy);
    const cancelled = await transfer(passengerId, "salida", "17:00");
    await post(`/transfers/${cancelled}/absence`, {});
    await transfer(passengerId, "salida", "13:00", "2026-10-24");
    await transfer(other.passengerId, "salida", "13:00");

    const absent = await answer(mark(driver.cookie, routeId, markBody(transferId, "ausente")), 201);
    expect(await alerts()).toEqual([{
      kind: "absent_on_entrada", transferId, routeId, markId: (await marks())[0].id,
      details: {
        remaining: [
          { transferId: fromTherapy, direction: "entrada", targetTime: "11:00", destinationName: "Escuela absent", originDestinationName: "Terapia absent" },
          { transferId: salida, direction: "salida", targetTime: "13:00", destinationName: "Escuela absent", originDestinationName: null },
        ],
      },
    }]);
    expect(absent.mark.kind).toBe("ausente");
    expect([await transferStatus(salida), await transferStatus(fromTherapy)]).toEqual(["planificado", "planificado"]);

    // Ausente on a salida lists nothing.
    const later = await served(other.passengerId, "salida", "15:00");
    await answer(mark(later.driver.cookie, later.routeId, markBody(later.transferId, "ausente")), 201);
    expect((await alerts()).map((alert) => alert.kind)).toEqual(["absent_on_entrada"]);
  });

  it("Rule 2 (#83): correcting or undoing an Ausente resolves its alert, records the Corrección that did it and never deletes the alert", async () => {
    const { passenger, served, office } = await setup("absent-resolved");
    const first = await passenger();
    const second = await passenger();
    const undone = await served(first.passengerId, "entrada", "08:00");
    const corrected = await served(second.passengerId, "entrada", "08:30");
    const inbox = async () => (await answer(request("/alerts", "GET", undefined, office), 200)).alerts as { markId: string; resolution: unknown }[];
    const resolutionOf = async (markId: string) => (await inbox()).find((alert) => alert.markId === markId)!.resolution;

    const firstAusente = markBody(undone.transferId, "ausente");
    await answer(mark(undone.driver.cookie, undone.routeId, firstAusente), 201);
    const secondAusente = markBody(corrected.transferId, "ausente");
    await answer(mark(corrected.driver.cookie, corrected.routeId, secondAusente), 201);
    expect(await resolutionOf(firstAusente.id)).toBeNull();
    expect(await resolutionOf(secondAusente.id)).toBeNull();

    // The Chofer undoes the first Ausente: its alert is resolved by that undo.
    clock.now = new Date("2026-10-23T12:01:00.000Z");
    const undo = markBody(undone.transferId, "undo", { corrects: firstAusente.id });
    await answer(mark(undone.driver.cookie, undone.routeId, undo), 201);
    expect(await resolutionOf(firstAusente.id)).toEqual({
      markId: undo.id, kind: "undo", at: "2026-10-23T12:01:00.000Z", reason: null,
      author: { userId: undone.driver.userId, username: "chofer-absent-resolved-1", role: "driver" },
    });

    // The Chofer corrects the second to Subió and then undoes that Corrección: the Ausente is in force again, so is its alert.
    const subio = markBody(corrected.transferId, "subio", { corrects: secondAusente.id });
    await answer(mark(corrected.driver.cookie, corrected.routeId, subio), 201);
    expect(await resolutionOf(secondAusente.id)).toMatchObject({ markId: subio.id, kind: "subio" });
    clock.now = new Date("2026-10-23T12:01:30.000Z");
    await answer(mark(corrected.driver.cookie, corrected.routeId, markBody(corrected.transferId, "undo", { corrects: subio.id })), 201);
    expect(await transferStatus(corrected.transferId)).toBe("ausente");
    expect(await resolutionOf(secondAusente.id)).toBeNull();

    // The Oficina corrects it, with a reason.
    clock.now = new Date("2026-10-23T12:30:00.000Z");
    const reason = "La escuela confirmó que viajó";
    const byOffice = (await answer(request(`/marks/${secondAusente.id}/corrections`, "POST", { kind: "subio", reason }, office), 201)).mark;
    expect(await resolutionOf(secondAusente.id)).toEqual({
      markId: byOffice.id, kind: "subio", at: "2026-10-23T12:30:00.000Z", reason,
      author: { userId: expect.any(Number), username: "oficina-absent-resolved", role: "office" },
    });

    // Nothing was deleted: both alerts are still in the inbox, with what they said when they were raised.
    expect((await alerts()).map((alert) => [alert.kind, alert.transferId])).toEqual([
      ["absent_on_entrada", undone.transferId], ["absent_on_entrada", corrected.transferId],
    ]);
    expect(await inbox()).toHaveLength(2);
  });
});

describe("Alert inbox", () => {
  it("lists the alerts newest first with their Pasajero and Chofer, only for the Oficina", async () => {
    const { passenger, served, office } = await setup("inbox");
    const { passengerId } = await passenger(true);
    const { driver, routeId, transferId } = await served(passengerId, "salida");
    const body = markBody(transferId, "entregado", { receiver: { kind: "other_adult", name: "Tía Sintética", dni: "-3000001" } });
    await answer(mark(driver.cookie, routeId, body), 201);
    clock.now = new Date("2026-10-23T12:01:00.000Z");
    await answer(mark(driver.cookie, routeId, { ...body, kind: "subio", receiver: undefined }), 200);
    const listed = await answer(request("/alerts", "GET", undefined, office), 200);
    expect(listed.alerts.map((alert: { kind: string; createdAt: string }) => [alert.kind, alert.createdAt])).toEqual([
      ["mark_conflict", "2026-10-23T12:01:00.000Z"],
      ["other_adult_handover", NOW],
    ]);
    expect(listed.alerts[1]).toEqual({
      id: expect.any(Number), kind: "other_adult_handover", createdAt: NOW, transferId, routeId, markId: body.id,
      passengerName: "Pasajero Sintético 1", driverName: "Chofer Sintético 1", details: { authorized: false, name: "Tía Sintética", dni: "-3000001" },
      resolution: null,
    });
    expect(await answer(request("/alerts", "GET", undefined, driver.cookie), 403)).toEqual({ error: "Office role required" });
  });
});
