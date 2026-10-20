import { hc } from "hono/client";
import type { AppType } from "@traslado/api";

const api = hc<AppType>(import.meta.env.VITE_API_URL ?? "http://localhost:3000");

export function App() {
  void api.health.$get;
  return <main><h1>Driver</h1><p>Scheduled transport driver workspace.</p></main>;
}
