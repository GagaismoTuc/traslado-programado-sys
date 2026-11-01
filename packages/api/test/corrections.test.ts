import { describe, expect, it } from "vitest";
import { createExecutionHarness, HOME, NOW } from "./helpers/execution.js";

const { clock, request, answer, rows, setup, markBody, mark } = createExecutionHarness("corrections-test");

const CALL_THE_OFFICE = "More than 2 minutes have passed since this Marca: call the Oficina to correct it";
const REASON_REQUIRED = "A Corrección by the Oficina requires a reason";

async function transferStatus(transferId: number) {
  return (await rows("SELECT status FROM transfers WHERE id = $1", [transferId]))[0].status;
}

async function markRow(clientId: string) {
  return (await rows("SELECT * FROM marks WHERE client_id = $1", [clientId]))[0];
}

function at(time: string) {
  clock.now = new Date(`2026-10-23T${time}.000Z`);
}

describe("Correcciones", () => {
  it("carries the corrected outcome or an undo that returns the Traslado to its previous state, referencing the original", async () => {
    const { passenger, served, school } = await setup("outcome");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    const ausente = markBody(transferId, "ausente");
    await answer(mark(driver.cookie, routeId, ausente), 201);

    at("12:00:30");
    const subio = markBody(transferId, "subio", { corrects: ausente.id });
    expect(await answer(mark(driver.cookie, routeId, subio), 201)).toEqual({
      mark: {
        id: subio.id, transferId, routeId, version: 1, kind: "subio", phoneTime: "2026-10-23T12:00:30.000Z",
        serverTime: "2026-10-23T12:00:30.000Z", location: HOME, receiver: null, flags: [], corrects: ausente.id,
      },
    });
    expect(await transferStatus(transferId)).toBe("subio");

    at("12:01:00");
    const entregado = markBody(transferId, "entregado", { receiver: { kind: "destination", destinationId: school } });
    await answer(mark(driver.cookie, routeId, entregado), 201);
    expect(await transferStatus(transferId)).toBe("entregado");

    // Undoing Entregado goes back to Subió; undoing that Subió goes back to the Ausente it replaced.
    at("12:01:30");
    const undoEntregado = markBody(transferId, "undo", { corrects: entregado.id });
    const undone = await answer(mark(driver.cookie, routeId, undoEntregado), 201);
    expect(undone.mark).toMatchObject({ id: undoEntregado.id, kind: "undo", receiver: null, corrects: entregado.id });
    expect(await transferStatus(transferId)).toBe("subio");
    at("12:02:00");
    await answer(mark(driver.cookie, routeId, markBody(transferId, "undo", { corrects: subio.id })), 201);
    expect(await transferStatus(transferId)).toBe("ausente");

    expect((await rows(
      `SELECT m.kind, c.client_id AS corrects FROM marks m LEFT JOIN marks c ON c.id = m.corrects_mark_id WHERE m.transfer_id = $1 ORDER BY m.id`,
      [transferId],
    ))).toEqual([
      { kind: "ausente", corrects: null },
      { kind: "subio", corrects: ausente.id },
      { kind: "entregado", corrects: null },
      { kind: "undo", corrects: entregado.id },
      { kind: "undo", corrects: subio.id },
    ]);
  });

  it("accepts the Chofer's correction of their last Marca when the phone times are within 2 minutes, even when it reaches the server much later", async () => {
    const { passenger, served, school } = await setup("window");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    const subio = markBody(transferId, "subio", { phoneTime: NOW });
    await answer(mark(driver.cookie, routeId, subio), 201);

    // Offline: the phone made the undo at 12:02:00, exactly 2 minutes later, and it reaches the server at 12:40.
    at("12:40:00");
    const undo = markBody(transferId, "undo", { corrects: subio.id, phoneTime: "2026-10-23T12:02:00.000Z" });
    expect((await answer(mark(driver.cookie, routeId, undo), 201)).mark).toMatchObject({
      phoneTime: "2026-10-23T12:02:00.000Z", serverTime: "2026-10-23T12:40:00.000Z", corrects: subio.id,
    });
    expect(await transferStatus(transferId)).toBe("planificado");

    // Only the last Marca in force is corrected: once Entregado follows Subió, Subió is not.
    const again = markBody(transferId, "subio", { phoneTime: "2026-10-23T12:41:00.000Z" });
    await answer(mark(driver.cookie, routeId, again), 201);
    await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", {
      phoneTime: "2026-10-23T12:41:30.000Z", receiver: { kind: "destination", destinationId: school },
    })), 201);
    expect(await answer(mark(driver.cookie, routeId, markBody(transferId, "undo", {
      corrects: again.id, phoneTime: "2026-10-23T12:42:00.000Z",
    })), 409)).toEqual({ error: "Only the Traslado's latest Marca can be corrected" });
    expect(await transferStatus(transferId)).toBe("entregado");
  });

  it("refuses a Chofer correction after 2 minutes with a message to call the Oficina and stores nothing", async () => {
    const { passenger, served } = await setup("late");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    const subio = markBody(transferId, "subio", { phoneTime: NOW });
    await answer(mark(driver.cookie, routeId, subio), 201);

    const late = markBody(transferId, "ausente", { corrects: subio.id, phoneTime: "2026-10-23T12:02:01.000Z" });
    expect(await answer(mark(driver.cookie, routeId, late), 409)).toEqual({ error: CALL_THE_OFFICE });
    // Sent again from the phone, it is refused again.
    expect(await answer(mark(driver.cookie, routeId, late), 409)).toEqual({ error: CALL_THE_OFFICE });
    expect((await rows("SELECT client_id FROM marks")).map((row) => row.client_id)).toEqual([subio.id]);
    expect(await transferStatus(transferId)).toBe("subio");
  });

  it("requires a reason for the Oficina's correction and records it after the Chofer's window", async () => {
    const { office, passenger, served } = await setup("reason");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    const subio = markBody(transferId, "subio");
    await answer(mark(driver.cookie, routeId, subio), 201);

    at("12:30:00");
    const correct = (body: unknown) => request(`/marks/${subio.id}/corrections`, "POST", body, office);
    expect(await answer(correct({ kind: "ausente" }), 400)).toEqual({ error: REASON_REQUIRED });
    expect(await answer(correct({ kind: "ausente", reason: "   " }), 400)).toEqual({ error: REASON_REQUIRED });
    expect(await rows("SELECT client_id FROM marks")).toHaveLength(1);
    expect(await transferStatus(transferId)).toBe("subio");

    const reason = "La familia avisó que el Pasajero no estaba";
    const corrected = await answer(correct({ kind: "ausente", reason }), 201);
    expect(corrected).toEqual({
      mark: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/), transferId, routeId, version: 1, kind: "ausente", phoneTime: "2026-10-23T12:30:00.000Z",
        serverTime: "2026-10-23T12:30:00.000Z", location: null, receiver: null, flags: [], corrects: subio.id, reason,
      },
    });
    expect(await markRow(corrected.mark.id)).toMatchObject({ driver_id: null, reason });
    expect(await transferStatus(transferId)).toBe("ausente");
    // Sent twice, the second finds the Marca already corrected.
    expect(await answer(correct({ kind: "ausente", reason }), 409)).toEqual({ error: "Only the Traslado's latest Marca can be corrected" });
    expect(await rows("SELECT client_id FROM marks")).toHaveLength(2);
  });

  it("never modifies the original Marca when it is corrected or undone", async () => {
    const { office, passenger, served } = await setup("original");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    const subio = markBody(transferId, "subio");
    await answer(mark(driver.cookie, routeId, subio), 201);
    const original = await markRow(subio.id);

    at("12:01:00");
    const ausente = markBody(transferId, "ausente", { corrects: subio.id });
    await answer(mark(driver.cookie, routeId, ausente), 201);
    const correction = await markRow(ausente.id);
    at("12:20:00");
    await answer(request(`/marks/${ausente.id}/corrections`, "POST", { kind: "undo", reason: "Marcado por error" }, office), 201);

    expect(await markRow(subio.id)).toEqual(original);
    expect(await markRow(ausente.id)).toEqual(correction);
    expect(await transferStatus(transferId)).toBe("subio");
  });

  it("undoing a corrected Marca restores the state it replaced", async () => {
    const { passenger, served } = await setup("undo-chain");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    const original = markBody(transferId, "ausente");
    await answer(mark(driver.cookie, routeId, original), 201);
    at("12:30:00");
    const corrected = markBody(transferId, "subio", { corrects: original.id, phoneTime: "2026-10-23T12:02:00.000Z" });
    await answer(mark(driver.cookie, routeId, corrected), 201);
    at("12:40:00");
    const undo = markBody(transferId, "undo", { corrects: corrected.id, phoneTime: "2026-10-23T12:04:00.000Z" });
    await answer(mark(driver.cookie, routeId, undo), 201);
    expect(await transferStatus(transferId)).toBe("ausente");
  });

  it("lets the Oficina correct a Marca again once the Corrección that replaced it is undone", async () => {
    const { office, passenger, served } = await setup("recorrect");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    const ausente = markBody(transferId, "ausente");
    await answer(mark(driver.cookie, routeId, ausente), 201);
    at("12:01:00");
    const subio = markBody(transferId, "subio", { corrects: ausente.id });
    await answer(mark(driver.cookie, routeId, subio), 201);
    at("12:01:30");
    await answer(mark(driver.cookie, routeId, markBody(transferId, "undo", { corrects: subio.id })), 201);
    expect(await transferStatus(transferId)).toBe("ausente");

    at("12:30:00");
    const corrected = await answer(request(`/marks/${ausente.id}/corrections`, "POST", { kind: "subio", reason: "La escuela confirmó que viajó" }, office), 201);
    expect(corrected.mark).toMatchObject({ kind: "subio", corrects: ausente.id });
    expect(await transferStatus(transferId)).toBe("subio");
    expect(await rows("SELECT client_id FROM marks WHERE transfer_id = $1", [transferId])).toHaveLength(4);
  });

  it("shows the Oficina a Traslado's planned times per version, its Marcas and Correcciones and the changes with their actors", async () => {
    const { office, passenger, served, publish } = await setup("history");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    await publish(routeId);
    at("12:20:00");
    const subio = markBody(transferId, "subio");
    await answer(mark(driver.cookie, routeId, subio), 201);
    at("12:21:00");
    const ausente = markBody(transferId, "ausente", { corrects: subio.id });
    await answer(mark(driver.cookie, routeId, ausente), 201);
    at("12:45:00");
    const reason = "El Pasajero viajó: lo confirmó la escuela";
    const corrected = (await answer(request(`/marks/${ausente.id}/corrections`, "POST", { kind: "subio", reason }, office), 201)).mark;

    const planned = await rows(
      `SELECT pv.version, l.kind, to_char(l.planned_time, 'HH24:MI') AS time FROM plan_version_legs l JOIN plan_versions pv ON pv.id = l.plan_version_id
        WHERE l.transfer_id = $1 ORDER BY pv.version, l.position`,
      [transferId],
    );
    const time = (version: number, kind: string) => planned.find((row) => row.version === version && row.kind === kind)!.time;
    const chofer = { userId: driver.userId, username: "chofer-history-1", role: "driver" };
    const oficina = { userId: expect.any(Number), username: "oficina-history", role: "office" };
    const history = await answer(request(`/transfers/${transferId}/history`, "GET", undefined, office), 200);
    expect(history).toEqual({
      transferId,
      status: "subio",
      versions: [1, 2].map((version) => ({
        routeId, version, publishedAt: expect.any(String), publishedBy: "oficina-history",
        driverName: "Chofer Sintético 1", pickupTime: time(version, "pickup"), dropoffTime: time(version, "dropoff"),
      })),
      marks: [
        { ...(await answer(mark(driver.cookie, routeId, subio), 200)).mark, author: chofer },
        { ...(await answer(mark(driver.cookie, routeId, ausente), 200)).mark, author: chofer },
        { ...corrected, author: oficina },
      ],
      changes: [
        { action: "created", before: null, after: expect.objectContaining({ passengerId }), occurredAt: expect.any(String), actor: { userId: expect.any(Number), name: "oficina-history" } },
        { action: "assigned", before: { routeId: null }, after: { routeId }, occurredAt: expect.any(String), actor: { userId: expect.any(Number), name: "oficina-history" } },
      ],
    });
    expect(history.marks.map((item: { kind: string; corrects?: string; reason?: string }) => [item.kind, item.corrects ?? null, item.reason ?? null]))
      .toEqual([["subio", null, null], ["ausente", subio.id, null], ["subio", ausente.id, reason]]);
  });

  it("lets only the Oficina correct a Marca and read a Traslado's history", async () => {
    const { passenger, served } = await setup("access");
    const { passengerId } = await passenger();
    const { driver, routeId, transferId } = await served(passengerId, "entrada");
    const subio = markBody(transferId, "subio");
    await answer(mark(driver.cookie, routeId, subio), 201);
    expect(await answer(request(`/marks/${subio.id}/corrections`, "POST", { kind: "undo", reason: "Prueba" }, driver.cookie), 403))
      .toEqual({ error: "Office role required" });
    expect(await answer(request(`/transfers/${transferId}/history`, "GET", undefined, driver.cookie), 403)).toEqual({ error: "Office role required" });
    expect(await answer(request(`/marks/${subio.id}/corrections`, "POST", { kind: "undo", reason: "Prueba" }), 401)).toMatchObject({ error: "Authentication required" });
    expect(await answer(request(`/transfers/${transferId}/history`, "GET"), 401)).toMatchObject({ error: "Authentication required" });
    expect(await rows("SELECT client_id FROM marks")).toHaveLength(1);
  });
});
