import { describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubErrorEvent, scrubString, stripUrlQueryAndFragment } from "./index";

describe("scrubErrorEvent", () => {
  it("strips Pasajero personal data, request bodies, query strings, cookies, auth headers and locations while keeping stack frames", () => {
    const syntheticPassenger = {
      id: 42,
      name: "Pasajero Sintético Uno",
      homeAddress: "Calle Inventada 202",
      homeLat: -26.8302,
      homeLng: -65.2101,
      accessNotes: "Portón verde, tocar timbre",
      companions: 1,
      frontSeat: true,
      wheelchair: true,
      medicalAlert: "Alerta sintética: llevar inhalador",
      authorizedAdults: [{ name: "Adulto Sintético Dos", dni: "40.123.456", phone: "+5493815550199", legalGuardian: true }],
    };

    const scrubbed = scrubErrorEvent({
      event_id: "a1b2c3d4e5f64789a1b2c3d4e5f64789",
      message: `Unhandled failure for ${JSON.stringify(syntheticPassenger)} near -26.8302, -65.2101 with DNI 40123456 and Bearer synthetic-secret-token`,
      user: { id: "7", username: "chofer.sintetico", ip_address: "203.0.113.10" },
      request: {
        method: "POST",
        url: "https://traslado.example/passengers?name=Pasajero+Sint%C3%A9tico+Uno&dni=-456789#frag",
        query_string: "name=Pasajero+Sint%C3%A9tico+Uno&dni=-456789",
        data: JSON.stringify(syntheticPassenger),
        cookies: { session: "synthetic-session-cookie", remember_device: "synthetic-remember-cookie" },
        headers: {
          "Content-Type": "application/json",
          Cookie: "session=synthetic-session-cookie; remember_device=synthetic-remember-cookie",
          Authorization: "Bearer synthetic-secret-token",
          "X-Api-Key": "synthetic-api-key",
          "X-Forwarded-For": "203.0.113.10",
          Forwarded: "for=203.0.113.11",
          "True-Client-IP": "203.0.113.12",
          "X-Client-IP": "203.0.113.13",
        },
      },
      exception: {
        values: [{
          type: "Error",
          value: "Unique violation: Key (name)=(Pasajero Sintético Uno) at homeAddress=\"Calle Inventada 202\" (-26.8302, -65.2101) DNI 40.123.456",
          stacktrace: {
            frames: [{
              filename: "packages/api/src/app.ts",
              function: "savePassenger",
              lineno: 412,
              colno: 18,
              vars: { payload: syntheticPassenger, coordinates: [-65.2101, -26.8302] },
            }],
          },
        }],
      },
      extra: {
        passenger: syntheticPassenger,
        driverPoint: [-65.2205, -26.8199],
        syntheticNegDni: { receiverDni: "-456789", receiverName: "Receptor Sintético Tres" },
      },
      breadcrumbs: [
        { category: "ui.input", message: "input#medical-alert", data: { value: "Alerta sintética: llevar inhalador" } },
        {
          category: "fetch",
          message: "POST https://traslado.example/passengers?search=Inventada",
          data: { url: "https://traslado.example/passengers?search=Inventada", method: "POST", request_body: syntheticPassenger, status_code: 500 },
        },
      ],
    });

    const serialized = JSON.stringify(scrubbed);
    for (const forbidden of [
      "Pasajero Sintético Uno", "Adulto Sintético Dos", "Receptor Sintético Tres", "Calle Inventada 202", "Portón verde",
      "llevar inhalador", "40123456", "40.123.456", "-456789", "3815550199", "-26.8302", "-65.2101", "-65.2205",
      "synthetic-session-cookie", "synthetic-remember-cookie", "synthetic-secret-token", "synthetic-api-key",
      "chofer.sintetico", "203.0.113.10", "203.0.113.11", "203.0.113.12", "203.0.113.13", "Inventada",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    expect(scrubbed.user).toBeUndefined();
    expect(scrubbed.request?.url).toBe("https://traslado.example/passengers");
    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.exception?.values?.[0]?.stacktrace?.frames?.[0]).toMatchObject({
      filename: "packages/api/src/app.ts", function: "savePassenger", lineno: 412, colno: 18,
    });
    expect(scrubBreadcrumb({ category: "ui.input", message: "Pasajero Sintético Uno" })).toBeNull();
    expect(scrubBreadcrumb({ category: "geolocation", data: { lat: -26.8302, lng: -65.2101 } })).toBeNull();
  });

  it("strips relative query strings, logentry fields and positional SQL params arrays", () => {
    const scrubbed = scrubErrorEvent({
      transaction: "GET /geocode?q=Calle+Inventada+202",
      logentry: {
        message: "Failed query on /passengers?name=Pasajero+Sintético+Uno",
        formatted: "Failed query on /passengers?name=Pasajero+Sintético+Uno",
        params: ["Pasajero Sintético Uno", "Calle Inventada 202"],
      },
      extra: {
        sqlError: {
          query: "INSERT INTO passengers (name, home_address, medical_alert) VALUES ($1, $2, $3)",
          params: ["Pasajero Sintético Uno", "Calle Inventada 202", "Alerta sintética: llevar inhalador"],
        },
      },
    });
    const serialized = JSON.stringify(scrubbed);
    for (const forbidden of ["Pasajero Sintético Uno", "Calle+Inventada+202", "Calle Inventada 202", "llevar inhalador"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(scrubbed.transaction).toBe("GET /geocode");
  });

  it("strips OSRM multi-stop coordinates, short-decimal coords arrays, root-relative queries and navigation breadcrumbs", () => {
    const scrubbed = scrubErrorEvent({
      transaction: "GET /?q=Calle+Inventada+202#Pasajero+Uno",
      message: 'Failed routing {"coords":[-65.22,-26.8]} via http://127.0.0.1:5000/route/v1/driving/-65.22,-26.84;-65.2,-26.82?overview=false',
      breadcrumbs: [
        {
          category: "navigation",
          data: { from: "/?name=Pasajero Uno", to: "/passengers#Pasajero+Uno" },
        },
        {
          category: "fetch",
          data: { url: "http://127.0.0.1:5000/route/v1/driving/-65.2036,-26.8241;-65.2101,-26.8302?steps=false" },
        },
      ],
    });

    const serialized = JSON.stringify(scrubbed);
    for (const forbidden of [
      "Calle+Inventada+202", "Pasajero+Uno", "Pasajero Uno",
      "-65.22", "-26.8", "-26.84", "-65.2", "-26.82", "-65.2036", "-26.8241", "-65.2101", "-26.8302",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(scrubbed.transaction).toBe("GET /");
    expect(scrubbed.breadcrumbs?.[0]?.data).toEqual({ from: "/", to: "/passengers" });
  });

  it("does not keep a Receptor name or a domicilio written in free text", () => {
    const event = scrubErrorEvent({
      exception: { values: [{ type: "Error", value: "Receptor Rosario Ficticia Gómez no figura entre los adultos de Avenida Imaginaria 4455" }] },
      extra: { record: { label: "Rosario Ficticia Gómez", residence: "Avenida Imaginaria 4455" } },
    });
    expect(JSON.stringify(event)).not.toMatch(/Rosario Ficticia|Avenida Imaginaria/);
  });

  it("does not send patient data in arbitrary extra payload or unstructured error message", () => {
    const event = scrubErrorEvent({
      exception: { values: [{ type: "Error", value: "Failed processing record: Synthetic Person, Example Avenue 19" }] },
      extra: { record: { label: "Synthetic Person", residence: "Example Avenue 19" } },
    });
    expect(JSON.stringify(event)).not.toMatch(/Synthetic Person|Example Avenue 19/);
  });

  it("redacts passenger payload in exception, database errors, unquoted keys and waypoint coordinates", () => {
    const passenger = { name: "Synthetic Passenger", homeAddress: "Synthetic Road 42", dni: "45678901" };
    const event = scrubErrorEvent({
      exception: { values: [{ value: `Database failed for passenger ${JSON.stringify(passenger)}` }] },
    });
    for (const value of Object.values(passenger)) {
      expect(JSON.stringify(event)).not.toContain(value);
    }

    const dbEvent = scrubErrorEvent({
      exception: { values: [{ value: "Failing row contains (Synthetic Passenger, Synthetic Road 42)." }] },
    });
    expect(JSON.stringify(dbEvent)).not.toMatch(/Synthetic Passenger|Synthetic Road 42/);

    expect(scrubString("failed name=Synthetic Passenger")).not.toContain("Passenger");

    expect(JSON.stringify(scrubErrorEvent({ extra: { waypoint: [-65, -26] } }))).not.toMatch(/-65|-26/);
    expect(scrubErrorEvent({ extra: { stopIds: [3, 5] } })).toEqual({ extra: { stopIds: [3, 5] } });

    expect(stripUrlQueryAndFragment("https://example.invalid/a?name=Synthetic#x")).toBe("https://example.invalid/a");
    expect(stripUrlQueryAndFragment("http://localhost/route/v1/driving/-65,-26;-66,-27")).not.toMatch(/-65,-26|-66,-27/);
    expect(scrubBreadcrumb({ category: "navigation", data: { from: "/a?name=Synthetic", to: "/b#Synthetic" } })?.data)
      .toEqual({ from: "/a", to: "/b" });
  });

  it("allows only exact safe messages and redacts prefixed, suffixed or mismatched logentry messages", () => {
    const prefixed = scrubErrorEvent({
      message: "OSRM Synthetic Person at Example Avenue 19",
      exception: {
        values: [
          { type: "TypeError", value: "Failed to fetch Synthetic Person at Example Avenue 19" },
          { type: "Error", value: "Synthetic Person at Example Avenue 19 is not a function" },
          { type: "Error", value: "Nominatim answered 503 Synthetic Person" },
        ],
      },
      logentry: {
        message: "Failed to fetch",
        formatted: "Failed to fetch Synthetic Person at Example Avenue 19",
        params: ["Synthetic Person", "Example Avenue 19"],
      },
    });

    const serialized = JSON.stringify(prefixed);
    expect(serialized).not.toMatch(/Synthetic Person|Example Avenue 19/);
    expect(prefixed.message).toBe("[REDACTED]");
    expect(prefixed.exception?.values?.[0]?.value).toBe("[REDACTED]");
    expect(prefixed.exception?.values?.[1]?.value).toBe("[REDACTED]");
    expect(prefixed.exception?.values?.[2]?.value).toBe("[REDACTED]");
    expect(prefixed.logentry).toEqual({ message: "Failed to fetch", formatted: "[REDACTED]" });

    const exact = scrubErrorEvent({
      message: "Nominatim answered 503",
      exception: {
        values: [
          { type: "TypeError", value: "Failed to fetch" },
          { type: "Error", value: "SERVER_EPOCH is required" },
        ],
      },
    });
    expect(exact.message).toBe("Nominatim answered 503");
    expect(exact.exception?.values?.[0]?.value).toBe("Failed to fetch");
    expect(exact.exception?.values?.[1]?.value).toBe("SERVER_EPOCH is required");
  });

  it("redacts untrusted free text across arbitrary extra, contexts, tags, frame vars, mechanism, headers, transaction and breadcrumbs", () => {
    const event = scrubErrorEvent({
      transaction: "GET /passengers/Synthetic Person at Example Avenue 19",
      request: {
        method: "POST",
        url: "https://traslado.example/passengers/Synthetic%20Person",
        headers: {
          "Content-Type": "application/json",
          "X-Custom": "Synthetic Person at Example Avenue 19",
        },
        env: { REMOTE_ADDR: "203.0.113.1", note: "Synthetic Person" },
      },
      exception: {
        values: [{
          type: "Error",
          value: "Failed to fetch",
          mechanism: { type: "generic", handled: true, data: { note: "Synthetic Person at Example Avenue 19" } },
          stacktrace: {
            frames: [{
              filename: "packages/api/src/app.ts",
              function: "savePassenger",
              lineno: 10,
              colno: 2,
              vars: { note: "Synthetic Person at Example Avenue 19" },
            }],
          },
        }],
      },
      extra: {
        record: {
          description: "Synthetic Person at Example Avenue 19",
          doc: 40123456,
          negDoc: -456789,
          tel: 3815550199,
          spot: [-65, -26],
          coord: -26.8302,
        },
      },
      contexts: {
        runtime: { name: "node", version: "24.22.1" },
        custom: { note: "Synthetic Person at Example Avenue 19" },
      },
      tags: {
        app: "api",
        server_epoch: "epoch-1",
        note: "Synthetic Person at Example Avenue 19",
      },
      breadcrumbs: [{
        category: "console",
        message: "Synthetic Person at Example Avenue 19",
        data: { note: "Synthetic Person at Example Avenue 19", method: "POST", status_code: 500 },
      }],
      fingerprint: ["{{ default }}", "Synthetic Person at Example Avenue 19"],
    });

    const serialized = JSON.stringify(event);
    expect(serialized).not.toMatch(/Synthetic Person|Example Avenue 19|203\.0\.113\.1|40123456|-456789|3815550199|-65|-26/);
    expect(event.tags?.app).toBe("api");
    expect(event.tags?.server_epoch).toBe("epoch-1");
    expect(event.tags?.note).toBe("[REDACTED]");
    expect(event.contexts?.runtime).toEqual({ name: "node", version: "24.22.1" });
    expect(event.request?.headers).toEqual({ "Content-Type": "application/json" });
    expect(event.request?.env).toBeUndefined();
    expect(event.exception?.values?.[0]?.mechanism).toMatchObject({ type: "generic", handled: true });
    expect(event.breadcrumbs?.[0]?.data).toMatchObject({ method: "POST", status_code: 500, note: "[REDACTED]" });
    expect(event.fingerprint).toEqual(["{{ default }}", "[REDACTED]"]);
  });
});
