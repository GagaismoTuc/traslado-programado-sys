import { ExpiryBanner } from "./ExpiryBanner";

export function OfficeNav() {
  return <>
    <nav aria-label="Office sections">
      <a href="/live">Live map</a>{" | "}
      <a href="/users">Users</a>{" | "}
      <a href="/destinations">Destinations</a>{" | "}
      <a href="/vehicle-features">Vehicle features</a>{" | "}
      <a href="/vehicles">Vehicles</a>{" | "}
      <a href="/drivers">Drivers</a>{" | "}
      <a href="/passengers">Passengers</a>{" | "}
      <a href="/plan">Plan diario</a>{" | "}
      <a href="/expiries">Vencimientos</a>{" | "}
      <a href="/alerts">Alerts</a>
    </nav>
    <ExpiryBanner />
  </>;
}
