import { describe, expect, it, vi } from "vitest";
import { createOfficeErrorTracker } from "./error-tracking";

describe("office error tracking SDK", () => {
  it("stays silent when no DSN is configured and scrubs Pasajero data from outgoing Sentry envelopes when enabled", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    const disabled = createOfficeErrorTracker({ dsn: "", fetchImpl: fetchSpy });
    disabled.captureError(new Error("ignored when disabled"));
    await disabled.flush();
    expect(fetchSpy).not.toHaveBeenCalled();

    const envelopes: string[] = [];
    const tracker = createOfficeErrorTracker({
      dsn: `https://${"a".repeat(32)}@glitchtip.example/_glitchtip/1`,
      environment: "test",
      fetchImpl: async (_input, init) => {
        const body = init?.body;
        envelopes.push(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array));
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    const passengerPayload = {
      name: "Pasajero Sintético Oficina",
      dni: "41234567",
      homeAddress: "Pasaje de Prueba 202",
      homeLat: -26.8241,
      homeLng: -65.2036,
      medicalAlert: "Alerta sintética: medicación de rescate",
      wheelchair: true,
      frontSeat: true,
    };

    tracker.addBreadcrumb({
      category: "fetch",
      message: "POST https://office.example/api/passengers?name=Pasajero+Sint%C3%A9tico+Oficina",
      data: {
        url: "https://office.example/api/passengers?name=Pasajero+Sint%C3%A9tico+Oficina",
        request_body: passengerPayload,
        headers: { Cookie: "session=synthetic-office-cookie", Authorization: "Bearer synthetic-office-token" },
      },
    });

    tracker.captureError(new Error(`Office save failed: ${JSON.stringify(passengerPayload)} at -26.8241, -65.2036`), {
      passenger: passengerPayload,
      request: {
        url: "https://office.example/passengers?dni=41234567",
        query_string: "dni=41234567",
        data: passengerPayload,
        cookies: { session: "synthetic-office-cookie" },
        headers: { Cookie: "session=synthetic-office-cookie", Authorization: "Bearer synthetic-office-token" },
      },
    });

    await tracker.flush();
    expect(envelopes).toHaveLength(1);
    const envelopeText = envelopes[0]!;
    expect(envelopeText).toContain("Office save failed");
    expect(envelopeText).toContain('"app":"office"');
    for (const forbidden of [
      "Pasajero Sintético Oficina", "41234567", "Pasaje de Prueba 202", "medicación de rescate",
      "-26.8241", "-65.2036", "synthetic-office-cookie", "synthetic-office-token",
    ]) {
      expect(envelopeText).not.toContain(forbidden);
    }
  });

  it("redacts unstructured free text errors containing passenger names or addresses by default", async () => {
    const envelopes: string[] = [];
    const tracker = createOfficeErrorTracker({
      dsn: `https://${"a".repeat(32)}@glitchtip.example/_glitchtip/1`,
      fetchImpl: async (_input, init) => {
        const body = init?.body;
        envelopes.push(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array));
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });

    tracker.captureError(new Error("Failed processing record: Synthetic Person, Example Avenue 19"));
    await tracker.flush();

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]).not.toContain("Synthetic Person");
    expect(envelopes[0]).not.toContain("Example Avenue 19");
  });
});
