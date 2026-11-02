import { describe, expect, it } from "vitest";
import { scrubBreadcrumb, scrubErrorEvent } from "./index";

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
      "chofer.sintetico", "203.0.113.10", "Inventada",
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
});
