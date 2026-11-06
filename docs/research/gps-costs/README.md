# Costos de rastreo GPS (relevamiento 2026-11-06)

Análisis de costos de las alternativas de rastreo GPS para las 11 vans, pedido por el cliente para comparar con la reactivación de Strix. Actualiza la investigación anterior, [`../gps-tracking.md`](../gps-tracking.md) (2026-10-28), que queda como historia. Todos los precios salen de páginas públicas vistas el 2026-11-06 y cada uno lleva su URL en el informe correspondiente; lo que no está publicado figura como hueco, no como cero.

## Informes

- [`equipos.md`](equipos.md): hardware de rastreo (precios en ARS, instalación, estado 2G/3G, compatibilidad con Traccar).
- [`chips.md`](chips.md): SIM y chips de datos para 11 líneas de 5-50 MB/mes.
- [`proveedores.md`](proveedores.md): proveedores de rastreo en Argentina y Tucumán, con precios y condiciones.
- [`plataformas-celular.md`](plataformas-celular.md): plataformas de tracking y el celular del Chofer como tracker.

## Comparación a 12 meses (11 vans)

ARS, IVA incluido salvo que se diga otra cosa. Los totales son cálculo propio a partir de los precios de los cuatro informes.

| Opción | Pago inicial | Por mes | Primer año | Desde el 2.º año |
|---|---|---|---|---|
| A. Reactivar Strix (plan Auto) | $0 instalación + deuda a consultar | $286.000 | $3.432.000 | $3.432.000 |
| B. Teltonika FMC920 + Conecty 25 MB + Traccar propio | $3.120.889 (equipos $2.090.000 + instalación ref. $1.030.889) | $53.900 | $3.767.689 | $646.800 |
| B'. Igual que B con Sinotrack ST-901L | $2.522.104 | $53.900 | $3.168.904 | $646.800 |
| C. Pixel.AR GPS (Tucumán) | $660.000 + instalación no publicada | $66.000 | $1.452.000 + instalación | $792.000 |
| D. Equipos propios + MegaTrack | $3.120.889 | ≈ $74.310 | ≈ $4.012.609 | ≈ $891.720 |
| E. Celular del Chofer (Traccar Client) | $0 | $0 | $0 | $0 |
| F. Última Marca (lo que ya hace v1) | $0 | $0 | $0 | $0 |

Notas:

- La instalación de referencia es la de RASTREOMOBILE en Buenos Aires ($93.717,22 por vehículo), porque no hay un precio publicado para Tucumán.
- MegaTrack cobra US$10 por mes; se convirtió a dólar tarjeta $2.041.
- Traccar en el VPS de producción no suma costo solo si entra al lado del sistema (no medido).
- No incluye el trabajo de desarrollo.

## Huecos abiertos

Las cotizaciones que no están publicadas (Strix Flotas y su deuda, instalación y API de Pixel.AR, Albiero, TrailingSat, instalación en Tucumán) figuran como huecos en los informes y siguen abiertas.
