import { describe, expect, it } from "vitest";
import { createExecutionHarness, HOME, NOW, TODAY } from "./helpers/execution.js";

const { request, answer, rows, setup, markBody, mark } = createExecutionHarness("incidents-test", {
  baseAddress: "Base Sintética, Calle Inventada 999",
});

async function incidentLog(routeId: number) {
  return await rows(
    "SELECT actor_user_id, entity_id, action, before_data, after_data FROM change_log WHERE entity = 'route' AND entity_id = $1 AND action = 'incident_reported'",
    [String(routeId)],
  );
}

async function alertsForRoute(routeId: number) {
  return await rows("SELECT id, kind, route_id, details, dedupe_key FROM alerts WHERE route_id = $1", [routeId]);
}

/** One started Recorrido of a new Chofer with assigned Pasajeros. Synthetic data only. */
async function startedRouteWithTransfers(name: string, count: number) {
  const harness = await setup(name);
  const driver = await harness.chofer();
  const routeId = await harness.route(driver.driverId);
  const transfers: { transferId: number; passengerId: number; passengerName: string; adultId: number }[] = [];
  for (let i = 0; i < count; i++) {
    const { passengerId, guardian } = await harness.passenger();
    const transferId = await harness.transfer(passengerId, "entrada", `08:0${i * 5}`);
    await harness.assign(transferId, routeId);
    transfers.push({ transferId, passengerId, passengerName: `Pasajero Sintético ${i + 1}`, adultId: guardian });
  }
  await harness.post(`/routes/${routeId}/publish`, { overrideReason: "Orden sintético" });
  await answer(request(`/driver/routes/${routeId}/start`, "POST", {}, driver.cookie), 200);

  const postIncident = async (payload: unknown, cookie = driver.cookie) => {
    return await request(`/driver/routes/${routeId}/incidents`, "POST", payload, cookie);
  };

  const sendMark = async (transferId: number, kind: "subio" | "ausente" | "entregado", fields: Record<string, unknown> = {}) => {
    return await answer(mark(driver.cookie, routeId, markBody(transferId, kind, fields)), 201);
  };

  return { ...harness, driver, routeId, transfers, postIncident, sendMark };
}

describe("Incidente reporting", () => {
  it("reports an incident, records it, alerts Oficina with children on board, and logs to change_log", async () => {
    const { routeId, transfers, postIncident, sendMark } = await startedRouteWithTransfers("reporting", 2);
    // Passenger 0 boards the vehicle (is on board); Passenger 1 has not boarded yet.
    await sendMark(transfers[0].transferId, "subio");

    const incidentId = "00000000-0000-4000-8000-000000000010";
    const payload = {
      id: incidentId,
      kind: "delay",
      note: "Congestión de tránsito por corte de calle",
      phoneTime: NOW,
      location: { lat: -26.835, lng: -65.215 },
    };

    const response = await postIncident(payload);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.incident).toMatchObject({
      id: incidentId,
      routeId,
      kind: "delay",
      note: "Congestión de tránsito por corte de calle",
      phoneTime: NOW,
      location: { lat: -26.835, lng: -65.215 },
    });
    expect(body.incident.serverTime).toBeDefined();

    // Idempotency: re-sending the same incident returns 200 with the existing record
    const resend = await postIncident(payload);
    expect(resend.status).toBe(200);
    const resendBody = await resend.json();
    expect(resendBody.incident.id).toBe(incidentId);

    // Alert in Oficina inbox with route and on-board children
    const alerts = await alertsForRoute(routeId);
    expect(alerts.length).toBe(1);
    expect(alerts[0].kind).toBe("incident");
    expect(alerts[0].route_id).toBe(routeId);
    expect(alerts[0].dedupe_key).toBe(`incident:${incidentId}`);
    const details = alerts[0].details as {
      kind: string;
      note: string;
      onBoard: { transferId: number; passengerName: string }[];
    };
    expect(details.kind).toBe("delay");
    expect(details.note).toBe("Congestión de tránsito por corte de calle");
    expect(details.onBoard).toEqual([
      { transferId: transfers[0].transferId, passengerName: transfers[0].passengerName },
    ]);

    // Change log entry
    const log = await incidentLog(routeId);
    expect(log.length).toBe(1);
    expect(log[0].action).toBe("incident_reported");
    expect(log[0].after_data).toMatchObject({
      clientId: incidentId,
      kind: "delay",
      note: "Congestión de tránsito por corte de calle",
    });
  });

  it("Regla 1: An Incidente never changes a Recorrido by itself", async () => {
    const { routeId, transfers, postIncident } = await startedRouteWithTransfers("regla-1", 1);
    const initialStatus = (await rows("SELECT status FROM routes WHERE id = $1", [routeId]))[0].status;
    expect(initialStatus).toBe("en_curso");

    const response = await postIncident({
      id: "00000000-0000-4000-8000-000000000011",
      kind: "vehicle_fault",
      note: "Pinchadura de neumático",
      phoneTime: NOW,
      location: null,
    });
    expect(response.status).toBe(201);

    const postStatus = (await rows("SELECT status FROM routes WHERE id = $1", [routeId]))[0].status;
    expect(postStatus).toBe("en_curso");

    // Transfers remain planificado
    const transferStatus = (await rows("SELECT status FROM transfers WHERE id = $1", [transfers[0].transferId]))[0].status;
    expect(transferStatus).toBe("planificado");
  });

  it("Regla 2: Pasajero health crisis is an Incidente kind; on diversion Chofer marks Entregado to Adulto autorizado at real place", async () => {
    const { routeId, transfers, postIncident, sendMark } = await startedRouteWithTransfers("regla-2", 1);
    await sendMark(transfers[0].transferId, "subio");

    // Chofer reports health_crisis
    const incidentResponse = await postIncident({
      id: "00000000-0000-4000-8000-000000000012",
      kind: "health_crisis",
      note: "Pasajero descompensado, desvío de emergencia hacia hospital",
      phoneTime: NOW,
      location: { lat: -26.84, lng: -65.22 },
    });
    expect(incidentResponse.status).toBe(201);

    // On diversion, Chofer delivers to an Adulto autorizado at the real place
    const diversionLocation = { lat: -26.845, lng: -65.225 };
    const markResult = await sendMark(transfers[0].transferId, "entregado", {
      receiver: { kind: "authorized_adult", adultId: transfers[0].adultId },
      location: diversionLocation,
    });
    expect(markResult.mark.kind).toBe("entregado");
    expect(markResult.mark.location).toEqual(diversionLocation);
    expect(markResult.mark.receiver).toEqual({ kind: "authorized_adult", adultId: transfers[0].adultId });

    // Transfer status is now entregado
    const transferStatus = (await rows("SELECT status FROM transfers WHERE id = $1", [transfers[0].transferId]))[0].status;
    expect(transferStatus).toBe("entregado");
  });

  it("validates input fields and rejects invalid requests", async () => {
    const { postIncident } = await startedRouteWithTransfers("validation", 1);

    // Invalid UUID
    expect((await postIncident({ id: "not-a-uuid", kind: "delay", note: "Nota", phoneTime: NOW, location: null })).status).toBe(400);

    // Invalid kind
    expect((await postIncident({ id: "00000000-0000-4000-8000-000000000099", kind: "invalid_kind", note: "Nota", phoneTime: NOW, location: null })).status).toBe(400);

    // Empty note
    expect((await postIncident({ id: "00000000-0000-4000-8000-000000000099", kind: "other", note: "   ", phoneTime: NOW, location: null })).status).toBe(400);

    // Invalid location coordinates (lat out of range)
    expect((await postIncident({ id: "00000000-0000-4000-8000-000000000099", kind: "other", note: "Nota", phoneTime: NOW, location: { lat: 100, lng: 0 } })).status).toBe(400);
  });

  it("refuses unauthorized callers (non-driver, wrong driver, missing session)", async () => {
    const { routeId, chofer, postIncident } = await startedRouteWithTransfers("auth", 1);
    const otherDriver = await chofer();

    const validPayload = {
      id: "00000000-0000-4000-8000-000000000098",
      kind: "other",
      note: "Nota de prueba",
      phoneTime: NOW,
      location: null,
    };

    // Unauthenticated
    const noAuth = await request(`/driver/routes/${routeId}/incidents`, "POST", validPayload);
    expect(noAuth.status).toBe(401);

    // Another driver calling on this route
    const wrongDriver = await request(`/driver/routes/${routeId}/incidents`, "POST", validPayload, otherDriver.cookie);
    expect(wrongDriver.status).toBe(403);
  });

  it("rejects duplicate client UUID submitted by a different driver without leaking data", async () => {
    const { driver, routeId, chofer, route, post } = await startedRouteWithTransfers("uuid-conflict", 1);
    const incidentId = "00000000-0000-4000-8000-000000000088";

    // Driver 1 records an incident
    const postIncident1 = await request(`/driver/routes/${routeId}/incidents`, "POST", {
      id: incidentId,
      kind: "delay",
      note: "Demora chofer 1",
      phoneTime: NOW,
      location: null,
    }, driver.cookie);
    expect(postIncident1.status).toBe(201);

    // Driver 2 starts their own route
    const driver2 = await chofer();
    const route2Id = await route(driver2.driverId);
    await post(`/routes/${route2Id}/publish`, { overrideReason: "Orden sintético chofer 2" });
    await answer(request(`/driver/routes/${route2Id}/start`, "POST", {}, driver2.cookie), 200);

    // Driver 2 attempts to send an incident with the same UUID
    const postIncident2 = await request(`/driver/routes/${route2Id}/incidents`, "POST", {
      id: incidentId,
      kind: "vehicle_fault",
      note: "Pinchadura chofer 2",
      phoneTime: NOW,
      location: null,
    }, driver2.cookie);

    expect(postIncident2.status).toBe(403);
    const body2 = await postIncident2.json();
    expect(body2.error).toBe("This Incidente belongs to another Chofer");
    expect(body2.incident).toBeUndefined();
  });
});
