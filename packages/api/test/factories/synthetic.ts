const FICTITIOUS_STREETS = [
  "Calle Inventada 101",
  "Pasaje de Prueba 202",
  "Avenida Sintetica 303",
] as const;

// Bounding box from the Tucuman province geometry in the geoAr dataset; points remain synthetic and are not real homes.
export const TUCUMAN_BOUNDS = {
  minLatitude: -28.01575,
  maxLatitude: -26.06037,
  minLongitude: -66.18101,
  maxLongitude: -64.48315,
} as const;

// Negative DNI placeholders are intentionally invalid as real identity numbers and only used in synthetic tests.
export const SYNTHETIC_DNI_RANGE = { min: -999999, max: -1 } as const;

export function createSyntheticRecord(random = Math.random) {
  return {
    marker: `synthetic-${random().toString(36).slice(2)}`,
    streetName: FICTITIOUS_STREETS[Math.floor(random() * FICTITIOUS_STREETS.length)],
    latitude: TUCUMAN_BOUNDS.minLatitude + random() * (TUCUMAN_BOUNDS.maxLatitude - TUCUMAN_BOUNDS.minLatitude),
    longitude: TUCUMAN_BOUNDS.minLongitude + random() * (TUCUMAN_BOUNDS.maxLongitude - TUCUMAN_BOUNDS.minLongitude),
    dni: Math.floor(random() * (SYNTHETIC_DNI_RANGE.max - SYNTHETIC_DNI_RANGE.min + 1)) + SYNTHETIC_DNI_RANGE.min,
  };
}
