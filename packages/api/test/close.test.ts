import { describe, expect, it } from "vitest";
import { createExecutionHarness } from "./helpers/execution.js";

const { request, answer, rows, setup, markBody, mark } = createExecutionHarness("close-test", {
  baseAddress: "Base Sintética, Calle Inventada 999",
});

async function routeStatus(routeId: number) {
  return (await rows("SELECT status FROM routes WHERE id = $1", [routeId]))[0].status;
}

async function closeLog() {
  return await rows(
    "SELECT actor_user_id, entity_id, action, before_data, after_data FROM change_log WHERE entity = 'route' AND action IN ('closed', 'close_refused') ORDER BY id",
  );
}

/** One started Recorrido of a new Chofer serving one Traslado per given direction and time, all of different Pasajeros. */
async function startedRoute(name: string, traslados: { direction: "entrada" | "salida"; targetTime: string }[]) {
  const harness = await setup(name);
  const driver = await harness.chofer();
  const routeId = await harness.route(driver.driverId);
  const transfers: { transferId: number; passengerName: string }[] = [];
  for (const [index, traslado] of traslados.entries()) {
    const { passengerId } = await harness.passenger();
    const transferId = await harness.transfer(passengerId, traslado.direction, traslado.targetTime);
    await harness.assign(transferId, routeId);
    transfers.push({ transferId, passengerName: `Pasajero Sintético ${index + 1}` });
  }
  // The gate does not depend on the order, so the Oficina forces the version past the time windows.
  await harness.post(`/routes/${routeId}/publish`, { overrideReason: "Orden sintético" });
  await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 200);
  const close = async (status: number) => await answer(request(`/driver/routes/${routeId}/close`, "POST", {}, driver.cookie), status);
  const send = async (transferId: number, kind: "subio" | "ausente" | "entregado", fields: Record<string, unknown> = {}) => {
    await answer(mark(driver.cookie, routeId, markBody(transferId, kind, fields)), 201);
  };
  return { ...harness, driver, routeId, transfers, close, send };
}

const REFUSED = "Resolve these Traslados before closing the Recorrido";

describe("Closing a Recorrido", () => {
  it("refuses to close while a Traslado is Planificado or Subió without Entregado and lists them", async () => {
    const { routeId, transfers: [delivered, onBoard, unmarked], close, send, school } = await startedRoute("gate", [
      { direction: "entrada", targetTime: "08:00" }, { direction: "entrada", targetTime: "08:30" }, { direction: "salida", targetTime: "13:00" },
    ]);
    await send(delivered.transferId, "subio");
    await send(delivered.transferId, "entregado", { receiver: { kind: "destination", destinationId: school } });
    await send(onBoard.transferId, "subio");
    expect(await close(409)).toEqual({
      error: REFUSED,
      transfers: [
        { transferId: onBoard.transferId, passengerName: onBoard.passengerName, direction: "entrada", status: "subio" },
        { transferId: unmarked.transferId, passengerName: unmarked.passengerName, direction: "salida", status: "planificado" },
      ],
    });
    expect(await routeStatus(routeId)).toBe("en_curso");
  });

  it("rule 1: never closes a Recorrido with a child Subió without Entregado, however many times it is asked", async () => {
    const { routeId, transfers: [onBoard], close, send } = await startedRoute("on-board", [{ direction: "salida", targetTime: "13:00" }]);
    await send(onBoard.transferId, "subio");
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await close(409)).transfers).toEqual([
        { transferId: onBoard.transferId, passengerName: onBoard.passengerName, direction: "salida", status: "subio" },
      ]);
    }
    expect(await routeStatus(routeId)).toBe("en_curso");
    expect((await rows("SELECT status FROM transfers WHERE id = $1", [onBoard.transferId]))[0].status).toBe("subio");
  });

  it("raises an Oficina alarm in the alert inbox when a close is refused", async () => {
    const { routeId, transfers: [onBoard], close, send, office } = await startedRoute("alarm", [{ direction: "entrada", targetTime: "08:00" }]);
    await send(onBoard.transferId, "subio");
    await close(409);
    expect((await answer(request("/alerts", "GET", undefined, office), 200)).alerts).toEqual([{
      id: expect.any(Number), kind: "close_refused", createdAt: "2026-10-23T12:00:00.000Z", transferId: null, routeId, markId: null,
      passengerName: null, driverName: "Chofer Sintético 1",
      details: { transfers: [{ transferId: onBoard.transferId, passengerName: onBoard.passengerName, direction: "entrada", status: "subio" }] },
    }]);
  });

  it("rule 2: logs every refused attempt", async () => {
    const { driver, routeId, transfers: [unmarked], close } = await startedRoute("log", [{ direction: "entrada", targetTime: "08:00" }]);
    await close(409);
    await close(409);
    const open = [{ transferId: unmarked.transferId, passengerName: unmarked.passengerName, direction: "entrada", status: "planificado" }];
    expect(await closeLog()).toEqual([1, 2].map(() => ({
      actor_user_id: driver.userId, entity_id: String(routeId), action: "close_refused", before_data: { status: "en_curso" }, after_data: { transfers: open },
    })));
    expect(await rows("SELECT kind, route_id, details FROM alerts ORDER BY id")).toEqual([1, 2].map(() => ({
      kind: "close_refused", route_id: routeId, details: { transfers: open },
    })));
  });

  it("lets the Recorrido close once each Planificado is Ausente, reassigned or cancelled and each Subió is Entregado", async () => {
    const started = await startedRoute("exits", [
      { direction: "entrada", targetTime: "08:00" }, { direction: "entrada", targetTime: "08:30" },
      { direction: "entrada", targetTime: "09:00" }, { direction: "salida", targetTime: "13:00" },
    ]);
    const { routeId, transfers: [absent, reassigned, cancelled, onBoard], close, send, chofer, route, assign, post } = started;
    const remaining = async () => (await close(409)).transfers.map((transfer: { transferId: number }) => transfer.transferId);
    await send(onBoard.transferId, "subio");
    expect(await remaining()).toEqual([absent.transferId, reassigned.transferId, cancelled.transferId, onBoard.transferId]);
    await send(absent.transferId, "ausente");
    expect(await remaining()).toEqual([reassigned.transferId, cancelled.transferId, onBoard.transferId]);
    const other = await chofer();
    await assign(reassigned.transferId, await route(other.driverId));
    expect(await remaining()).toEqual([cancelled.transferId, onBoard.transferId]);
    await post(`/transfers/${cancelled.transferId}/absence`, {});
    expect(await remaining()).toEqual([onBoard.transferId]);
    await send(onBoard.transferId, "entregado", { receiver: { kind: "authorized_adult", adultId: (await rows(
      "SELECT a.id FROM authorized_adults a JOIN transfers t ON t.passenger_id = a.passenger_id WHERE t.id = $1 ORDER BY a.id LIMIT 1",
      [onBoard.transferId],
    ))[0].id } });
    expect(await close(200)).toEqual({ route: { routeId, status: "cerrado" } });
  });

  it("moves the Recorrido from En curso to Cerrado when allowed, and only from En curso", async () => {
    const { driver, routeId, transfers: [absent], close, send, chofer, route, publish, transfer, assign, passenger } = await startedRoute(
      "closed", [{ direction: "entrada", targetTime: "08:00" }],
    );
    await send(absent.transferId, "ausente");
    expect(await close(200)).toEqual({ route: { routeId, status: "cerrado" } });
    expect(await routeStatus(routeId)).toBe("cerrado");
    // Closing it again changes nothing and logs nothing; it cannot be started again.
    expect(await close(200)).toEqual({ route: { routeId, status: "cerrado" } });
    expect(await closeLog()).toEqual([
      { actor_user_id: driver.userId, entity_id: String(routeId), action: "closed", before_data: { status: "en_curso" }, after_data: { status: "cerrado" } },
    ]);
    expect(await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 409)).toEqual({ error: "This Recorrido is closed" });

    const other = await chofer();
    const published = await route(other.driverId);
    const { passengerId } = await passenger();
    await assign(await transfer(passengerId, "salida", "13:00"), published);
    await publish(published);
    const third = await chofer();
    const draft = await route(third.driverId);
    for (const [id, status, cookie] of [[published, "publicado", other.cookie], [draft, "borrador", third.cookie]] as const) {
      expect(await answer(request(`/driver/routes/${id}/close`, "POST", {}, cookie), 409)).toEqual({ error: "Only a Recorrido en curso can be closed" });
      expect(await routeStatus(id)).toBe(status);
    }
    expect(await answer(request(`/driver/routes/${routeId}/close`, "POST", {}, other.cookie), 403))
      .toEqual({ error: "This Recorrido belongs to another Chofer" });
    expect(await closeLog()).toHaveLength(1);
    expect(await rows("SELECT id FROM alerts WHERE kind = 'close_refused'")).toEqual([]);
  });

  it("rule 3: an Entregado to company staff at the base counts as handed over", async () => {
    const { routeId, transfers: [atBase], close, send } = await startedRoute("base", [{ direction: "salida", targetTime: "13:00" }]);
    await send(atBase.transferId, "subio");
    await send(atBase.transferId, "entregado", { receiver: { kind: "base_staff" } });
    expect(await rows("SELECT kind, receiver_kind FROM marks WHERE transfer_id = $1 ORDER BY id", [atBase.transferId]))
      .toEqual([{ kind: "subio", receiver_kind: null }, { kind: "entregado", receiver_kind: "base_staff" }]);
    expect((await rows("SELECT status FROM transfers WHERE id = $1", [atBase.transferId]))[0].status).toBe("entregado");
    expect(await close(200)).toEqual({ route: { routeId, status: "cerrado" } });
  });

  it("rule 1: flags a Subió that reaches a closed Recorrido and alerts the Oficina", async () => {
    const { driver, routeId, transfers: [absent], close, send } = await startedRoute("late-board", [{ direction: "entrada", targetTime: "08:00" }]);
    await send(absent.transferId, "ausente");
    await close(200);
    const late = await answer(mark(driver.cookie, routeId, markBody(absent.transferId, "subio")), 201);
    expect(late.mark.flags).toEqual(["route_closed"]);
    expect(await rows("SELECT kind, transfer_id, route_id, details FROM alerts WHERE kind = 'mark_flagged'")).toEqual([
      { kind: "mark_flagged", transfer_id: absent.transferId, route_id: routeId, details: { reasons: ["route_closed"] } },
    ]);
  });
});
