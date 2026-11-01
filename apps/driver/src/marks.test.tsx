import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteView, type DriverRoute, type DriverStop, type Marking } from "./Days";
import {
  CALL_THE_OFFICE, currentLocation, fetchHandover, HandoverView, newMark, otherAdultReceiver, sendMark, startRoute,
  type Handover, type HandoverActions,
} from "./Marks";

afterEach(() => {
  vi.unstubAllGlobals();
});

// Synthetic data only: negative DNIs are never real identity numbers.
const AUNT = { name: "Tía Sintética", dni: "-3000001" };
const handover = (fields: Partial<Handover> = {}): Handover => ({
  transferId: 3, otherAdultAllowed: false, adults: [{ id: 5, name: "Madre Sintética", relation: "madre" }], authorizations: [],
  base: { address: "Base Sintética, Calle Inventada 999" }, ...fields,
});
const passenger = { name: "Pasajero Sintético", wheelchair: false, medicalAlert: null };
const stop = (kind: "pickup" | "dropoff", transferStatus: string, destinationId: number | null): DriverStop => ({
  position: kind === "pickup" ? 1 : 2, kind, plannedTime: "13:00", transferId: 3, direction: destinationId === null ? "salida" : "entrada",
  transferStatus, place: { name: destinationId === null ? null : "Escuela Sintética", destinationId, address: "Calle Inventada 101", accessNotes: null },
  passenger, companions: 0,
});
const route = (status: string, stops: DriverStop[]): DriverRoute => ({
  routeId: 9, version: 2, startTime: "07:00", endTime: "18:00", vehiclePlate: "AAA001", status, acknowledgedVersion: 2, stops,
});
const marking = (fields: Partial<Marking> = {}): Marking => ({
  sending: false, marks: {}, planFetchedAt: "2026-10-23T11:00:00.000Z", handover: null, onStart: vi.fn(), onMark: vi.fn(), onFlush: vi.fn(), onOpenHandover: vi.fn(),
  onOtherAdult: vi.fn(), onSearch: vi.fn(), ...fields,
});
const actions = (): HandoverActions => ({ onReceiver: vi.fn(), onOtherAdult: vi.fn(), onSearch: vi.fn() });

/** Expands function components (these have no hooks) and returns every <button> with its text and onClick. */
function buttons(node: ReactNode): { text: string; onClick: () => void }[] {
  const text = (child: ReactNode): string => Array.isArray(child) ? child.map(text).join("")
    : isValidElement(child) ? text((child.props as { children?: ReactNode }).children) : child === null || child === undefined || typeof child === "boolean" ? "" : String(child);
  const walk = (child: ReactNode): { text: string; onClick: () => void }[] => {
    if (Array.isArray(child)) return child.flatMap(walk);
    if (!isValidElement(child)) return [];
    const element = child as ReactElement<{ children?: ReactNode; onClick?: () => void }>;
    if (typeof element.type === "function") return walk((element.type as (props: unknown) => ReactNode)(element.props));
    if (element.type === "button") return [{ text: text(element.props.children), onClick: element.props.onClick ?? (() => undefined) }];
    return walk(element.props.children);
  };
  return walk(node);
}

function press(node: ReactNode, label: string) {
  const button = buttons(node).find((item) => item.text === label);
  if (!button) throw new Error(`No button "${label}" in ${JSON.stringify(buttons(node).map((item) => item.text))}`);
  button.onClick();
}

describe("Handover at home (case table)", () => {
  it("row 1: with the Consentimiento allowing another adult, name and DNI are enough", () => {
    expect(otherAdultReceiver(handover({ otherAdultAllowed: true }), { ...AUNT, adultConfirmed: false }))
      .toEqual({ ok: true, receiver: { kind: "other_adult", ...AUNT } });
    expect(otherAdultReceiver(handover({ otherAdultAllowed: true }), { name: " ", dni: AUNT.dni, adultConfirmed: false }))
      .toEqual({ ok: false, message: "Write the receiver's name and DNI" });
    const markup = renderToStaticMarkup(<HandoverView handover={handover({ otherAdultAllowed: true })} blocked={null} searching={false} actions={actions()} />);
    expect(markup).not.toContain(CALL_THE_OFFICE);
    expect(markup).not.toContain("Buscar autorización");
  });

  it("row 2: an Adulto autorizado at home receives the Pasajero", () => {
    const handlers = actions();
    press(<HandoverView handover={handover()} blocked={null} searching={false} actions={handlers} />, "Madre Sintética (madre)");
    expect(handlers.onReceiver).toHaveBeenCalledWith({ kind: "authorized_adult", adultId: 5 });
  });

  it("rows 3 and 6: without a valid Autorización puntual the app blocks and says to call the Oficina", () => {
    expect(otherAdultReceiver(handover(), { ...AUNT, adultConfirmed: true })).toEqual({ ok: false, message: "no entregues, llamá a la Oficina" });
    const markup = renderToStaticMarkup(<HandoverView handover={handover()} blocked={null} searching={false} actions={actions()} />);
    expect(markup).toContain("<p role=\"alert\">no entregues, llamá a la Oficina</p>");
  });

  it("row 4: an Autorización puntual whose DNI matches the one typed at the door lets the adult receive", () => {
    const authorized = handover({ authorizations: [{ id: 11, ...AUNT }] });
    expect(otherAdultReceiver(authorized, { name: AUNT.name, dni: "-3.000.001", adultConfirmed: true }))
      .toEqual({ ok: true, receiver: { kind: "other_adult", name: AUNT.name, dni: "-3.000.001", authorizationId: 11 } });
    const markup = renderToStaticMarkup(<HandoverView handover={authorized} blocked={null} searching={false} actions={actions()} />);
    expect(markup).toContain("Autorización puntual: Tía Sintética. Type the DNI shown to you at the door.");
    expect(markup).not.toContain(AUNT.dni);
  });

  it("row 5 and rule 7: a DNI that differs blocks, and so does a receiver not confirmed as an adult", () => {
    const authorized = handover({ authorizations: [{ id: 11, ...AUNT }] });
    expect(otherAdultReceiver(authorized, { name: AUNT.name, dni: "-3000009", adultConfirmed: true }))
      .toEqual({ ok: false, message: "The DNI does not match the Autorización puntual: no entregues, llamá a la Oficina" });
    expect(otherAdultReceiver(authorized, { ...AUNT, adultConfirmed: false })).toEqual({ ok: false, message: "Confirm the receiver is an adult" });
    expect(renderToStaticMarkup(<HandoverView handover={authorized} blocked={null} searching={false} actions={actions()} />))
      .toContain("<label><input type=\"checkbox\" name=\"adultConfirmed\"/>The receiver is an adult</label>");
    expect(renderToStaticMarkup(<HandoverView handover={authorized} blocked="Confirm the receiver is an adult" searching={false} actions={actions()} />))
      .toContain("<p role=\"alert\">Confirm the receiver is an adult</p>");
  });

  it("row 8: company staff at the base can always receive, which lets the Recorrido close", () => {
    const handlers = actions();
    press(<HandoverView handover={handover()} blocked={null} searching={false} actions={handlers} />, "Company staff at the base (Base Sintética, Calle Inventada 999)");
    expect(handlers.onReceiver).toHaveBeenCalledWith({ kind: "base_staff" });
    expect(buttons(<HandoverView handover={handover({ base: null })} blocked={null} searching={false} actions={handlers} />).map((item) => item.text))
      .toContain("Company staff at the base");
  });

  it("\"Buscar autorización\" downloads the handover again, never from a cache", async () => {
    const handlers = actions();
    press(<HandoverView handover={handover()} blocked={CALL_THE_OFFICE} searching={false} actions={handlers} />, "Buscar autorización");
    expect(handlers.onSearch).toHaveBeenCalledTimes(1);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchHandover("https://api.example", 9, 3);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/driver/routes/9/transfers/3/handover", { credentials: "include", cache: "no-store" });
  });
});

describe("Marcas in the driver app", () => {
  it("offers to start a published Recorrido and posts the start", async () => {
    const actionsFor = marking();
    const published = route("publicado", [stop("pickup", "planificado", null)]);
    press(<RouteView route={published} sending={false} onAcknowledge={() => undefined} marking={actionsFor} />, "Start Recorrido");
    expect(actionsFor.onStart).toHaveBeenCalledWith(published);
    expect(renderToStaticMarkup(<RouteView route={route("en_curso", [])} sending={false} onAcknowledge={() => undefined} marking={marking()} />))
      .toContain("<p>Recorrido en curso.</p>");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await startRoute("https://api.example", 9);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/driver/routes/9/start", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}",
    });
  });

  it("marks Subió or Ausente at a pickup and Entregado to the Destino once on board", () => {
    const actionsFor = marking();
    const entrada = route("en_curso", [stop("pickup", "planificado", 4), stop("dropoff", "subio", 4)]);
    const view = <RouteView route={entrada} sending={false} onAcknowledge={() => undefined} marking={actionsFor} />;
    press(view, "Subió");
    press(view, "Ausente");
    press(view, "Entregado at Escuela Sintética");
    expect(vi.mocked(actionsFor.onMark).mock.calls.map((call) => call.slice(2))).toEqual([
      ["subio"], ["ausente"], ["entregado", { kind: "destination", destinationId: 4 }],
    ]);
    const marked = renderToStaticMarkup(<RouteView route={route("en_curso", [stop("pickup", "subio", 4)])} sending={false} onAcknowledge={() => undefined} marking={marking()} />);
    expect(marked).toContain("<div>Marked: Subió</div>");
    expect(marked).not.toContain(">Subió</button>");
  });

  it("opens the Receptor choice at a home drop-off instead of sending an Entregado without one", () => {
    const actionsFor = marking();
    const salida = route("en_curso", [stop("dropoff", "subio", null)]);
    press(<RouteView route={salida} sending={false} onAcknowledge={() => undefined} marking={actionsFor} />, "Entregado");
    expect(actionsFor.onOpenHandover).toHaveBeenCalledWith(salida, salida.stops[0]);
    expect(actionsFor.onMark).not.toHaveBeenCalled();
    const open = marking({ handover: { transferId: 3, data: handover(), blocked: null, searching: false } });
    expect(renderToStaticMarkup(<RouteView route={salida} sending={false} onAcknowledge={() => undefined} marking={open} />)).toContain("<h4>Who receives?</h4>");
  });

  it("keeps blocking without signal and still offers buscar autorización and the base", () => {
    const actionsFor = marking({ handover: { transferId: 3, data: null, blocked: "Unable to reach the server", searching: false } });
    const salida = route("en_curso", [stop("dropoff", "subio", null)]);
    const view = <RouteView route={salida} sending={false} onAcknowledge={() => undefined} marking={actionsFor} />;
    const markup = renderToStaticMarkup(view);
    expect(markup).toContain("<p role=\"alert\">no entregues, llamá a la Oficina</p>");
    expect(markup).toContain("<p role=\"alert\">Unable to reach the server</p>");
    press(view, "Buscar autorización");
    press(view, "Company staff at the base");
    expect(actionsFor.onSearch).toHaveBeenCalledWith(salida, salida.stops[0]);
    expect(actionsFor.onMark).toHaveBeenCalledWith(salida, salida.stops[0], "entregado", { kind: "base_staff" });
  });

  it("keeps a Marca's UUID and phone time to send it again after a failure", async () => {
    const mark = newMark({ transferId: 3, kind: "subio", location: null, version: 2 }, new Date("2026-10-23T12:00:00.000Z"), "00000000-0000-4000-8000-000000000001");
    expect(mark).toEqual({ id: "00000000-0000-4000-8000-000000000001", phoneTime: "2026-10-23T12:00:00.000Z", transferId: 3, kind: "subio", location: null, version: 2 });
    const actionsFor = marking({ marks: { 3: { id: mark.id, routeId: 9, mark, state: "pending", confirmedAt: null, note: null } } });
    const view = <RouteView route={route("en_curso", [stop("pickup", "planificado", null)])} sending={false} onAcknowledge={() => undefined} marking={actionsFor} />;
    press(view, "Send now");
    expect(actionsFor.onFlush).toHaveBeenCalledTimes(1);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendMark("https://api.example", 9, mark);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example/driver/routes/9/marks", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(mark),
    });
  });

  it("shows each Marca as saved on phone until the server confirms it, and does not offer it again", () => {
    const subio = newMark({ transferId: 3, kind: "subio", location: null, version: 2 }, new Date("2026-10-23T12:00:00.000Z"), "00000000-0000-4000-8000-000000000001");
    const queued = (state: "pending" | "confirmed", confirmedAt: string | null = null, note: string | null = null) => ({
      3: { id: subio.id, routeId: 9, mark: subio, state, confirmedAt, note },
    });
    // The plan was downloaded at 11:00, before the Marca: it still says Planificado.
    const entrada = route("en_curso", [stop("pickup", "planificado", 4), stop("dropoff", "planificado", 4)]);
    const render = (fields: Partial<Marking>, shown = entrada) => renderToStaticMarkup(
      <RouteView route={shown} sending={false} onAcknowledge={() => undefined} marking={marking(fields)} />,
    );

    const saved = render({ marks: queued("pending", null, "This Recorrido is closed") });
    expect(saved).toContain("<div>Marked: Subió</div><div>Saved on phone</div><p role=\"alert\">This Recorrido is closed</p><button type=\"button\">Send now</button>");
    expect(saved).not.toContain(">Ausente</button>");
    expect(saved).toContain(">Entregado at Escuela Sintética</button>");

    const confirmed = render({ marks: queued("confirmed", "2026-10-23T12:00:05.000Z") });
    expect(confirmed).toContain("<div>Marked: Subió</div><div>Confirmed by server</div>");
    expect(confirmed).not.toContain("Send now");
    expect(render({ marks: queued("confirmed", "2026-10-23T12:00:05.000Z") }, route("en_curso", [stop("pickup", "subio", 4)])))
      .toContain("<div>Marked: Subió</div><div>Confirmed by server</div>");
    // A plan requested after the confirmation is the server's word: an Oficina change since then wins.
    const changed = render({ marks: queued("confirmed", "2026-10-23T12:00:05.000Z"), planFetchedAt: "2026-10-23T12:30:00.000Z" });
    expect(changed).not.toContain("Marked:");
    expect(changed).not.toContain("Confirmed by server");
    expect(changed).toContain(">Subió</button>");
  });

  it("takes the phone's position, or none when the GPS fails or is missing", async () => {
    const working = { getCurrentPosition: (success: PositionCallback) => success({ coords: { latitude: -26.83, longitude: -65.21 } } as GeolocationPosition) };
    const failing = { getCurrentPosition: (_: PositionCallback, failure?: PositionErrorCallback | null) => failure?.({} as GeolocationPositionError) };
    expect(await currentLocation(working)).toEqual({ lat: -26.83, lng: -65.21 });
    expect(await currentLocation(failing)).toBeNull();
    expect(await currentLocation(undefined)).toBeNull();
  });
});
