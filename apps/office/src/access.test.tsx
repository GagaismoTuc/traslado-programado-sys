import { renderToStaticMarkup } from "react-dom/server";
import qrcode from "qrcode-generator";
import { describe, expect, it } from "vitest";
import { readError } from "./api";
import { CodeForm, EnrolmentDetails, SecondFactorPage } from "./SecondFactor";
import { DeviceSessionList, PersistentSessionToggle, UnconfirmedTransferList } from "./UserAccess";

const enrolment = {
  secret: "A4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYH",
  uri: "otpauth://totp/Traslado%20Programado:office?issuer=Traslado+Programado&algorithm=SHA1&secret=A4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYH&period=30&digits=6",
};

describe("office access screens", () => {
  it("renders TOTP enrolment, code entry, device sessions with revoke, the persistent toggle and the last-Oficina message", async () => {
    const enrolMarkup = renderToStaticMarkup(<EnrolmentDetails enrolment={enrolment} />);
    const reference = qrcode(0, "M");
    reference.addData(enrolment.uri);
    reference.make();
    let dark = 0;
    for (let row = 0; row < reference.getModuleCount(); row++) {
      for (let column = 0; column < reference.getModuleCount(); column++) if (reference.isDark(row, column)) dark++;
    }
    expect(enrolMarkup).toContain('aria-label="QR code for the authenticator app"');
    expect(enrolMarkup.match(/h1v1h-1z/g)).toHaveLength(dark);
    expect(enrolMarkup).toContain(`<code>${enrolment.secret}</code>`);
    expect(renderToStaticMarkup(<SecondFactorPage initialStep="enrolment_required" />)).toContain("Start setup");

    const codeMarkup = renderToStaticMarkup(<SecondFactorPage initialStep="code_required" />);
    expect(codeMarkup).toContain("<h1>Enter your code</h1>");
    expect(codeMarkup).toContain('name="code"');
    expect(codeMarkup).toContain('<input type="checkbox" name="rememberDevice"/> Remember this device for 30 days');
    expect(renderToStaticMarkup(<CodeForm onSubmit={() => undefined} error="Invalid code" busy={false} />)).toContain('<p role="alert">Invalid code</p>');

    const sessions = renderToStaticMarkup(<DeviceSessionList onRevoke={() => undefined} sessions={[
      { id: 4, device_label: "Van phone", created_at: "2026-10-23T12:00:00.000Z", last_used_at: "2026-10-23T13:00:00.000Z", current: false },
      { id: 5, device_label: "Office laptop", created_at: "2026-10-23T12:00:00.000Z", last_used_at: "2026-10-23T13:00:00.000Z", current: true },
    ]} />);
    expect(sessions).toContain("Van phone");
    expect(sessions).toContain("Office laptop (this device)");
    expect(sessions.match(/>Revocar por pérdida o robo<\/button>/g)).toHaveLength(2);

    expect(renderToStaticMarkup(<PersistentSessionToggle userId={2} persistent />)).toContain('type="checkbox" checked=""');
    expect(renderToStaticMarkup(<PersistentSessionToggle userId={2} persistent={false} />)).not.toContain("checked");

    const lastOffice = new Response(JSON.stringify({ error: "The last active Oficina account cannot be disabled" }), { status: 409 });
    expect(await readError(lastOffice, "Unable to disable user")).toBe("The last active Oficina account cannot be disabled");
  });

  it("shows after a revocation the Chofer's Traslados of today without a confirmed Marca, each linked to its history", () => {
    const markup = renderToStaticMarkup(<UnconfirmedTransferList date="2026-10-23" transfers={[
      { transferId: 7, routeId: 3, passengerName: "Pasajero Sintético", direction: "entrada", targetTime: "08:00", destinationName: "Escuela Sintética" },
    ]} />);
    expect(markup).toContain("<p>Traslados of 2026-10-23 without a confirmed Marca:</p>");
    expect(markup).toContain('<a href="/transfers/7/history">08:00 Pasajero Sintético, entrada, Escuela Sintética</a>');
    expect(renderToStaticMarkup(<UnconfirmedTransferList date="2026-10-23" transfers={[]} />))
      .toBe("<p>Every Traslado of 2026-10-23 has a confirmed Marca.</p>");
  });
});
