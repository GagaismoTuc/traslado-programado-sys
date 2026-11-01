import { useEffect, useState } from "react";
import { send } from "./api";

export type ExpiryItem = {
  id: number;
  name: string;
  expiresOn: string | null;
  daysLeft: number | null;
  owner: { kind: "vehicle" | "driver"; id: number; label: string };
};
/** What GET /expiries returns: `documents` are expired or expire within 30 days of `today` (Tucumán); `undated` have no date. */
export type ExpiryPanel = { today: string; documents: ExpiryItem[]; undated: ExpiryItem[] };
/** A dismissed banner: the day it was dismissed and the documents it was showing then. */
export type BannerDismissal = { date: string; keys: string[] };

const DISMISSAL_KEY = "expiryBannerDismissal";
const reloads = new Set<() => void>();

/** Tells the banner a document was written, so it reloads and comes back if a new document entered the list. */
export function announceDocumentsChanged() {
  for (const reload of reloads) reload();
}

// A document re-enters the list with a new date, so the key includes the date.
function bannerKey(item: ExpiryItem) {
  return `${item.id}:${item.expiresOn}`;
}

/** The banner shows while there are documents to alert about, unless dismissed today and nothing new entered the list since. */
export function bannerVisible(panel: ExpiryPanel, dismissal: BannerDismissal | null) {
  if (!panel.documents.length) return false;
  if (!dismissal || dismissal.date !== panel.today) return true;
  return panel.documents.some((item) => !dismissal.keys.includes(bannerKey(item)));
}

export function dismissalOf(panel: ExpiryPanel): BannerDismissal {
  return { date: panel.today, keys: panel.documents.map(bannerKey) };
}

export function ExpiryBannerView({ count, onDismiss }: { count: number; onDismiss: () => void }) {
  return <p role="alert">
    <a href="/expiries">{`${count} ${count === 1 ? "document is" : "documents are"} expired or expiring within 30 days`}</a>
    {" "}
    <button type="button" onClick={onDismiss}>Dismiss until tomorrow</button>
  </p>;
}

function readDismissal(): BannerDismissal | null {
  try {
    return JSON.parse(window.localStorage.getItem(DISMISSAL_KEY) ?? "null") as BannerDismissal | null;
  } catch {
    return null;
  }
}

/** Banner on every office page; a failed load shows nothing, since the page itself handles sign-in. */
export function ExpiryBanner() {
  const [panel, setPanel] = useState<ExpiryPanel | null>(null);
  const [dismissal, setDismissal] = useState<BannerDismissal | null>(readDismissal);

  useEffect(() => {
    function load() {
      void send("/expiries", "GET")
        .then(async (response) => { if (response.ok) setPanel(await response.json() as ExpiryPanel); })
        .catch(() => undefined);
    }
    load();
    reloads.add(load);
    return () => { reloads.delete(load); };
  }, []);

  if (!panel || !bannerVisible(panel, dismissal)) return null;
  function dismiss() {
    const next = dismissalOf(panel!);
    window.localStorage.setItem(DISMISSAL_KEY, JSON.stringify(next));
    setDismissal(next);
  }
  return <ExpiryBannerView count={panel.documents.length} onDismiss={dismiss} />;
}
