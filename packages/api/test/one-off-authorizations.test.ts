import { describe, expect, it } from "vitest";
import { createExecutionHarness, NOW } from "./helpers/execution.js";

const { appPool, clock, request, answer, rows, setup, markBody, mark } = createExecutionHarness("one-off-authorizations-test");

const AUNT = { name: "Tía Sintética", dni: "-3000001" };

async function alerts() {
  return (await rows("SELECT kind, transfer_id, mark_id, details FROM alerts ORDER BY id")).map((row) => ({
    kind: row.kind, transferId: row.transfer_id, markId: row.mark_id, details: row.details,
  }));
}

async function stored() {
  return await rows("SELECT * FROM one_off_authorizations ORDER BY id");
}

/** A salida of a Pasajero whose Consentimiento does not allow another adult, published for a new Chofer. */
async function salida(name: string) {
  const context = await setup(name);
  const people = await context.passenger(false);
  const trip = await context.served(people.passengerId, "salida");
  const record = (body: Record<string, unknown>, transferId = trip.transferId) =>
    request(`/transfers/${transferId}/authorizations`, "POST", { legalGuardianId: people.guardian, call: "outgoing", ...AUNT, ...body }, context.office);
  const handover = async () => await answer(
    request(`/driver/routes/${trip.routeId}/transfers/${trip.transferId}/handover`, "GET", undefined, trip.driver.cookie),
    200,
  );
  return { ...context, ...people, ...trip, record, handover };
}

describe("Autorización puntual", () => {
  it("lets only a Responsable legal of the Pasajero give it, on a salida whose Consentimiento does not allow another adult", async () => {
    const { record, neighbour, guardian, passenger, served, transfer, passengerId, transferId, officeId } = await salida("guardian");
    const elsewhere = await passenger(false);
    const onlyGuardian = { error: "Only a Responsable legal of this Pasajero can give an Autorización puntual" };
    expect(await answer(record({ legalGuardianId: neighbour }), 409)).toEqual(onlyGuardian);
    expect(await answer(record({ legalGuardianId: elsewhere.guardian }), 409)).toEqual(onlyGuardian);
    expect(await answer(record({}, await transfer(passengerId, "entrada", "08:00")), 409))
      .toEqual({ error: "An Autorización puntual is for a handover at home, and only a salida ends there" });
    const allowing = await passenger(true);
    const allowed = await served(allowing.passengerId, "salida");
    expect(await answer(record({ legalGuardianId: allowing.guardian }, allowed.transferId), 409))
      .toEqual({ error: "The Consentimiento already allows another adult: no Autorización puntual is needed" });
    expect(await stored()).toEqual([]);

    expect(await answer(record({}), 201)).toEqual({
      authorization: {
        id: expect.any(Number), transferId, authorizedBy: { adultId: guardian, name: "Madre Sintética" }, calledPhone: "381-000-0001",
        ...AUNT, recordedBy: officeId, recordedAt: NOW, revokedBy: null, revokedAt: null, status: "valid",
      },
    });
  });

  it("lets only the Responsable legal who signed the Consentimiento give it, not another adult flagged as a guardian", async () => {
    const { passengerId, office, record } = await salida("only-current-signer");
    const { adult } = await answer(request(`/passengers/${passengerId}/authorized-adults`, "POST", {
      name: "Synthetic second guardian", dni: "-5000001", relation: "family", phone: "381-000-0002", legalGuardian: true,
    }, office), 201);
    expect(await answer(record({ legalGuardianId: adult.id }), 409))
      .toEqual({ error: "Only a Responsable legal of this Pasajero can give an Autorización puntual" });
    expect(await stored()).toEqual([]);

    // Once the Consentimiento is signed again by that adult, they are the Responsable legal.
    await answer(request(`/passengers/${passengerId}/consent`, "POST", {
      signedByAdultId: adult.id, signedAt: "2026-10-02", otherAdultAllowed: false,
    }, office), 200);
    expect((await answer(record({ legalGuardianId: adult.id }), 201)).authorization)
      .toMatchObject({ authorizedBy: { adultId: adult.id, name: "Synthetic second guardian" }, calledPhone: "381-000-0002" });
  });

  it("counts only a call the Oficina makes to the Responsable legal's registered phone", async () => {
    const { record, transferId, guardian, office } = await salida("call");
    expect(await answer(record({ call: "incoming" }), 409))
      .toEqual({ error: "Only a call the Oficina makes to the Responsable legal's registered phone counts, not an incoming call" });
    expect(await answer(record({ call: undefined }), 400)).toEqual({ error: "Invalid request" });
    expect(await stored()).toEqual([]);
    // The phone stored is the registered one, as it was when the Oficina called.
    await answer(record({}), 201);
    await answer(request(`/authorized-adults/${guardian}`, "PATCH", {
      name: "Madre Sintética", dni: "-1000001", relation: "madre", phone: "381-999-9999", legalGuardian: true,
    }, office), 200);
    expect((await answer(request(`/transfers/${transferId}/authorizations`, "GET", undefined, office), 200)).authorizations
      .map((item: { calledPhone: string }) => item.calledPhone)).toEqual(["381-000-0001"]);
  });

  it("refuses one that names a place: it changes who receives, never where", async () => {
    const { record } = await salida("place");
    for (const place of [{ address: "Pasaje de Prueba 202" }, { lat: -26.8, lng: -65.2 }, { destinationId: 1 }]) {
      expect(await answer(record(place), 400), JSON.stringify(place))
        .toEqual({ error: "An Autorización puntual changes who receives, never where: a different place is a new Parada through a Versión del plan" });
    }
    expect(await stored()).toEqual([]);
  });

  it("is append-only with who recorded it, when and who authorised, and can be revoked while unused", async () => {
    const { record, office, officeId, guardian, transferId, handover, driver, routeId } = await salida("revoke");
    const { authorization } = await answer(record({}), 201);
    expect(await rows("SELECT actor_user_id, action, after_data FROM change_log WHERE entity = 'one_off_authorization'")).toEqual([{
      actor_user_id: officeId, action: "recorded",
      after_data: { transferId, legalGuardianId: guardian, calledPhone: "381-000-0001", ...AUNT },
    }]);
    await expect(appPool.query("UPDATE one_off_authorizations SET dni = '-1'")).rejects.toThrow(/permission denied/i);
    await expect(appPool.query("DELETE FROM one_off_authorizations")).rejects.toThrow(/permission denied/i);

    clock.now = new Date("2026-10-23T12:10:00.000Z");
    const revoked = await answer(request(`/authorizations/${authorization.id}/revocation`, "POST", {}, office), 201);
    expect(revoked.authorization).toMatchObject({ status: "revoked", revokedBy: officeId, revokedAt: "2026-10-23T12:10:00.000Z" });
    expect(await answer(request(`/authorizations/${authorization.id}/revocation`, "POST", {}, office), 200)).toEqual(revoked);
    await expect(appPool.query("DELETE FROM one_off_authorization_revocations")).rejects.toThrow(/permission denied/i);
    await expect(appPool.query("UPDATE one_off_authorization_revocations SET revoked_by = revoked_by")).rejects.toThrow(/permission denied/i);
    // Case table row 6: a revoked authorization is not downloaded, so the app keeps blocking.
    expect((await handover()).authorizations).toEqual([]);

    // Case table row 7: the phone used it before it heard of the revocation; the Entregado stands, flagged.
    const used = await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", {
      phoneTime: "2026-10-23T12:05:00.000Z", receiver: { kind: "other_adult", ...AUNT, authorizationId: authorization.id },
    })), 201);
    expect(used.mark.flags).toEqual(["authorization_revoked"]);
    expect((await rows("SELECT status FROM transfers WHERE id = $1", [transferId]))[0].status).toBe("entregado");
    expect(await answer(request("/authorizations/999999/revocation", "POST", {}, office), 404)).toEqual({ error: "Autorización puntual not found" });
  });

  it("is used once, keeps the Entregado when a revocation arrives after its use, and expires when its Traslado closes", async () => {
    const { record, office, transferId, driver, routeId, handover } = await salida("once");
    const { authorization } = await answer(record({}), 201);
    const spare = (await answer(record({ name: "Abuela Sintética", dni: "-3000002" }), 201)).authorization;
    expect((await handover()).authorizations).toEqual([
      { id: authorization.id, ...AUNT }, { id: spare.id, name: "Abuela Sintética", dni: "-3000002" },
    ]);
    // Case table row 4: the typed DNI matches, written with dots; the alert is marked as authorised.
    const receiver = { kind: "other_adult", name: AUNT.name, dni: "-3.000.001", authorizationId: authorization.id };
    const first = await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", { receiver })), 201);
    expect(first.mark.flags).toEqual([]);
    const markId = (await rows("SELECT id FROM marks"))[0].id;

    const conflict = { error: "The Autorización puntual was already used: the Entregado stands and the conflict is in the alert inbox" };
    expect(await answer(request(`/authorizations/${authorization.id}/revocation`, "POST", {}, office), 409)).toEqual(conflict);
    expect(await answer(request(`/authorizations/${authorization.id}/revocation`, "POST", {}, office), 409)).toEqual(conflict);
    expect(await rows("SELECT * FROM one_off_authorization_revocations")).toEqual([]);
    expect((await rows("SELECT status FROM transfers WHERE id = $1", [transferId]))[0].status).toBe("entregado");

    // A second use of the same authorization does not count.
    const again = await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", { receiver })), 201);
    expect(again.mark.flags).toEqual(["consent_mismatch"]);
    const secondId = (await rows("SELECT id FROM marks ORDER BY id"))[1].id;
    expect(await alerts()).toEqual([
      { kind: "other_adult_handover", transferId, markId, details: { authorized: true, name: AUNT.name, dni: "-3.000.001" } },
      { kind: "authorization_conflict", transferId, markId, details: { authorizationId: authorization.id, name: AUNT.name } },
      { kind: "other_adult_handover", transferId, markId: secondId, details: { authorized: false, name: AUNT.name, dni: "-3.000.001" } },
      { kind: "mark_flagged", transferId, markId: secondId, details: { reasons: ["consent_mismatch"] } },
    ]);

    // The Traslado closed: the unused one expired and is neither downloaded, revoked nor recorded again.
    const listed = await answer(request(`/transfers/${transferId}/authorizations`, "GET", undefined, office), 200);
    expect(listed.authorizations.map((item: { status: string }) => item.status)).toEqual(["used", "expired"]);
    expect(await answer(request(`/authorizations/${spare.id}/revocation`, "POST", {}, office), 409))
      .toEqual({ error: "The Autorización puntual expired when its Traslado closed" });
    expect(await answer(record({}), 409)).toEqual({ error: "The Traslado is closed: an Autorización puntual expires when its Traslado closes" });
  });

  it("flags a handover whose typed DNI differs from the authorised one and leaves the authorization unused", async () => {
    const { record, transferId, driver, routeId, served, passengerId, handover, office } = await salida("dni");
    const { authorization } = await answer(record({}), 201);
    // Case table row 5, seen by the server: the DNI does not match.
    const receiver = { kind: "other_adult", name: AUNT.name, dni: "-3000009", authorizationId: authorization.id };
    expect((await answer(mark(driver.cookie, routeId, markBody(transferId, "subio")), 201)).mark.flags).toEqual([]);
    expect((await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", { receiver })), 201)).mark.flags)
      .toEqual(["consent_mismatch"]);
    expect((await alerts())[0].details).toEqual({ authorized: false, name: AUNT.name, dni: "-3000009" });
    // Naming it on another Traslado does not use it either.
    const other = await served(passengerId, "salida", "15:00");
    const elsewhere = { kind: "other_adult", ...AUNT, authorizationId: authorization.id };
    expect((await answer(mark(other.driver.cookie, other.routeId, markBody(other.transferId, "entregado", { receiver: elsewhere })), 201)).mark.flags)
      .toEqual(["consent_mismatch"]);
    const listed = await answer(request(`/transfers/${transferId}/authorizations`, "GET", undefined, office), 200);
    expect(listed.authorizations.map((item: { status: string }) => item.status)).toEqual(["expired"]);
    expect(await answer(request(`/authorizations/${authorization.id}/revocation`, "POST", {}, office), 409))
      .toEqual({ error: "The Autorización puntual expired when its Traslado closed" });
    expect((await alerts()).map((alert) => alert.kind)).not.toContain("authorization_conflict");
    expect((await handover()).authorizations).toEqual([]);
  });

  it("stays valid and revocable after a Marca names it with another DNI before its Traslado closes", async () => {
    const { record, transferId, driver, routeId, handover, office } = await salida("unused");
    const { authorization } = await answer(record({}), 201);
    // A Subió after the wrong-DNI Entregado (newer phone time) keeps the Traslado open, as an Oficina correction would.
    await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", {
      phoneTime: "2026-10-23T11:00:00.000Z", receiver: { kind: "other_adult", name: AUNT.name, dni: "-3000009", authorizationId: authorization.id },
    })), 201);
    await answer(mark(driver.cookie, routeId, markBody(transferId, "subio")), 201);
    expect((await handover()).authorizations).toEqual([{ id: authorization.id, ...AUNT }]);
    expect((await answer(request(`/authorizations/${authorization.id}/revocation`, "POST", {}, office), 201)).authorization.status).toBe("revoked");
  });

  it("downloads an Autorización puntual recorded after the phone last asked, only to the Chofer of that Recorrido", async () => {
    const { record, handover, guardian, neighbour, routeId, transferId, served, passengerId, driver } = await salida("download");
    expect(await handover()).toEqual({
      transferId, otherAdultAllowed: false,
      adults: [{ id: guardian, name: "Madre Sintética", relation: "madre" }, { id: neighbour, name: "Vecino Sintético", relation: "vecino" }],
      authorizations: [], base: null,
    });
    const { authorization } = await answer(record({}), 201);
    expect((await handover()).authorizations).toEqual([{ id: authorization.id, ...AUNT }]);

    const other = await served(passengerId, "salida", "15:00");
    expect(await answer(request(`/driver/routes/${routeId}/transfers/${transferId}/handover`, "GET", undefined, other.driver.cookie), 403))
      .toEqual({ error: "This Recorrido belongs to another Chofer" });
    expect(await answer(request(`/driver/routes/${routeId}/transfers/${other.transferId}/handover`, "GET", undefined, driver.cookie), 404))
      .toEqual({ error: "Traslado not found in this Recorrido" });
  });

  it("lets only the Oficina record, list and revoke Autorizaciones puntuales and read the alert inbox", async () => {
    const { record, transferId, driver } = await salida("roles");
    const { authorization } = await answer(record({}), 201);
    const endpoints: [string, string, unknown][] = [
      [`/transfers/${transferId}/authorizations`, "GET", undefined],
      [`/transfers/${transferId}/authorizations`, "POST", { legalGuardianId: 1, call: "outgoing", ...AUNT }],
      [`/authorizations/${authorization.id}/revocation`, "POST", {}],
      ["/alerts", "GET", undefined],
    ];
    for (const [path, method, body] of endpoints) {
      expect(await answer(request(path, method, body), 401), `${method} ${path}`).toEqual({ error: "Authentication required" });
      expect(await answer(request(path, method, body, driver.cookie), 403), `${method} ${path}`).toEqual({ error: "Office role required" });
    }
    expect((await stored()).map((row) => row.id)).toEqual([authorization.id]);
    expect(await rows("SELECT * FROM one_off_authorization_revocations")).toEqual([]);
  });
});

describe("The Receptor's DNI in the history (#95)", () => {
  /** Records an Entregado to another adult with each DNI, in order, and returns the DNIs the history gives for them. */
  async function historyDnis(name: string, dnis: string[]) {
    const { office, transferId, driver, routeId } = await salida(name);
    for (const dni of dnis) {
      await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", { receiver: { kind: "other_adult", name: AUNT.name, dni } })), 201);
    }
    const history = await answer(request(`/transfers/${transferId}/history`, "GET", undefined, office), 200);
    return history.marks.map((item: { receiver: { dni?: string } }) => item.receiver.dni);
  }

  it("Rule 1: the history gives only the last 3 digits of the DNI, without its dots and spaces", async () => {
    expect(await historyDnis("mask", ["40.123.456", "40 123 457", "1234"])).toEqual(["***456", "***457", "***234"]);
  });

  it("Rule 2: the history gives *** for a DNI with fewer than 4 digits", async () => {
    expect(await historyDnis("short", ["123", "1.2 3"])).toEqual(["***", "***"]);
  });

  it("Rule 4: the Marca, the alerts and the Autorizaciones puntuales still give the whole DNI", async () => {
    const { record, office, transferId, driver, routeId } = await salida("whole");
    const { authorization } = await answer(record({ dni: "40.123.456" }), 201);
    const receiver = { kind: "other_adult", name: AUNT.name, dni: "40.123.456", authorizationId: authorization.id };
    const sent = await answer(mark(driver.cookie, routeId, markBody(transferId, "entregado", { receiver })), 201);
    expect(sent.mark.receiver).toEqual(receiver);
    const inbox = await answer(request("/alerts", "GET", undefined, office), 200);
    expect(inbox.alerts.filter((alert: { kind: string }) => alert.kind === "other_adult_handover").map((alert: { details: unknown }) => alert.details))
      .toEqual([{ authorized: true, name: AUNT.name, dni: "40.123.456" }]);
    const listed = await answer(request(`/transfers/${transferId}/authorizations`, "GET", undefined, office), 200);
    expect(listed.authorizations.map((item: { dni: string }) => item.dni)).toEqual(["40.123.456"]);
  });

  it("Rule 5: the Marca keeps the whole DNI stored while the history masks it", async () => {
    expect(await historyDnis("stored", ["40.123.456"])).toEqual(["***456"]);
    expect((await rows("SELECT receiver_dni FROM marks")).map((row) => row.receiver_dni)).toEqual(["40.123.456"]);
  });
});
