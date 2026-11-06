# Proveedores de rastreo GPS en Argentina: precios y condiciones (ARS)

Fecha de relevamiento: **2026-11-06**. Fuente: páginas públicas leídas con ego-browser (sin cuentas, sin formularios, sin contacto). Todo precio lleva su URL. Donde no hay precio publicado se escribe `no publicado`. Los precios con IVA incluido se indican; los demás son los que muestra el sitio, sin aclaración de IVA.

Contexto: 11 vehículos (8 Kangoo, 1 Boxer, 2 Hiace), Tucumán, integración en tiempo real con un sistema propio de ruteo alojado en un VPS en Alemania.

## 1. Hallazgos que cambian la decisión

1. **Pixel.AR GPS** tiene base en San Miguel de Tucumán (Combate de las Piedras 388), publica precios y no exige permanencia. Es el único proveedor local con tarifa pública. Su política de privacidad dice que los datos pueden procesarse en servidores fuera de Argentina, incluidos EE. UU. y la UE, y que el historial GPS se borra a los 45 días. No publica API.
2. **MegaTrack** es la única plataforma con API pública REST (OpenAPI 3) y webhooks, y con precio publicado: **US$ 10/mes** hasta 20 dispositivos. Es solo software: se conectan equipos propios o del instalador. Su política no garantiza residencia de datos en una región. Cobra en dólares y no es una empresa argentina (su política aplica la ley colombiana 1581).
3. **STRIX (ex LoJack)**: el plan "Strix en tu Auto" cuesta **$ 26.000/mes** con instalación $0. Para empresas, "Strix Flotas" es solo cotización. Sus T&C de Flotas dicen que los datos "podrán ser almacenados en una base de datos radicada en Estados Unidos". Es decir, con Strix el dato ya sale de Argentina hacia un país sin protección adecuada, algo que hay que revisar bajo la Ley 25.326 antes de reactivar. No se encontró API pública de Strix Flotas.
4. Casi todos los proveedores con central de monitoreo y recupero (Strix, Ituran, Prosegur, MaxTracker, USS, TrailingSat) **no publican precio de flota**; es cotización.

## 2. Tabla de proveedores con datos públicos

| Proveedor | Abono ARS/mes/vehículo | Equipo | Instalación | Permanencia | API / export | Tucumán | URL | Fecha |
|---|---|---|---|---|---|---|---|---|
| **Pixel.AR GPS** (Tucumán) | Plataforma $ 5.000; chip M2M $ 2.000 (25 MB/mes); combo plataforma + chip **$ 6.000** | Rastreador 4G con corte de motor y botón de pánico **$ 60.000** pago único (envío gratis) | No incluida; costo variable, `no publicado` | **Sin permanencia** (cambio de plan sin penalidad) | No publicada. Reporta cada 20-30 s. Ofrece plataforma "apta para reventa". El catálogo de equipos lista protocolos Traccar y Wialon IPS | **Sí, sede en San Miguel de Tucumán**, tel. +54 381 518-5622 | https://pixelargps.com/precios ; https://pixelargps.com/privacidad ; https://pixelargps.com/dispositivos | 2026-11-06 |
| **MegaTrack** (SaaS white-label) | **US$ 10/mes** plan Básico (20 dispositivos, 40 usuarios); US$ 20 (50 disp.); US$ 40 (100 disp.); US$ 80 (250 disp.); o **US$ 1,25 por dispositivo/mes** (10 cupos = US$ 12,50). Trimestral −5 %, anual −10 % | No vende equipo: se conectan los que ya existen (consultar compatibilidad) | No aplica | "Cambia o cancela cuando quieras" | **API REST v1 (OpenAPI 3), claves Bearer con scopes, cuota diaria por plan, webhooks de eventos**. Plan con acceso a API: confirmar cuál | No es proveedor local | https://megatrackgps.app/#pricing ; https://megatrackgps.app/api ; https://megatrackgps.app/privacy | 2026-11-06 |
| **STRIX** "Strix en tu Auto" | **$ 26.000** (suscripción mensual) | Comodato (propiedad de la empresa) | **$ 0** | Los T&C de Flotas renuevan por períodos iguales; baja con 30 días de aviso; la baja pedida después del día 20 factura el mes siguiente. No hay "permanencia" con penalidad en lo leído | Sin API pública hallada. App y portal web | **Sí**: Punto Strix Ricagar SRL, Av. Néstor Kirchner 2929, SMT (según buscador; el mapa oficial es dinámico y no se leyó) | https://tienda.strix.com.ar ; https://strix.com.ar/legales/flotas/terminos-y-condiciones | 2026-11-06 |
| **STRIX** "Recupero Vehicular Auto" (solo monitoreo, sin app) | $ 22.000 | Comodato | $ 0 | idem | No tiene app | idem | https://tienda.strix.com.ar | 2026-11-06 |
| **Ituran** (particulares, referencia) | Protección Plus $ 30.499; Emergencia $ 32.499; plan superior $ 35.499 | Equipo propio | Promoción "instalación 100 % bonificada" (Facebook de Ituran, `no verificado en su sitio`) | `no publicado` | App y web multiusuario en flota; API `no publicada` | Centros de instalación: lista no leída (mapa dinámico) | https://www.ituran.com.ar/particulares/ | 2026-11-06 |
| **SmartTrack** (AMBA) | Servicio por **1 mes $ 16.350**; 6 meses $ 81.750 (≈ $ 13.625/mes); 12 meses $ 163.500 (≈ $ 13.625/mes). Asumido por equipo; confirmar | LV12 autoinstalable $ 43.739; GS900 4G con corte $ 48.599; LV12PRO con corte, pánico y sensor de puerta $ 55.079 | Autoinstalable (video); envío $ 6.000 | Prepago por 1/6/12 meses | `no publicada` | Sin presencia en Tucumán hallada; lista de distribuidores sin datos | https://smarttrack.com.ar/equipos-gps/ | 2026-11-06 |
| **Tracker.ar** (AMBA) | $ 28.000 mensual; **$ 20.000 equivalente con pago anual de $ 240.000**; corte de motor +$ 3.000; 10 % de descuento desde el segundo vehículo | Incluido, en comodato; se devuelve al terminar | A domicilio solo en CABA y GBA | Anual = 12 meses prepagos | `no publicada` | **No**: solo AMBA | https://www.tracker.ar/precio | 2026-11-06 |
| **SPS Seguridad** (solo resultado del buscador) | $ 26.344,72 IVA incluido ($ 21.772,50 sin IVA), con "30 % OFF por 3 meses" | Kit $ 60.499 IVA incluido ($ 49.999,17 sin IVA) | Profesional, a domicilio, `costo no publicado` | `no publicado` | `no publicada` | Cobertura por zonas (AMBA); Tucumán no confirmada | https://www.sps.com.ar/tienda/vehiculos/seguridad-vehicular | 2026-11-06 |

Notas: los precios de SPS vienen del extracto del buscador, porque la página cargada sin JavaScript no los mostraba. Validar antes de usarlos.

## 3. Proveedores solo por cotización (sin precio publicado)

| Proveedor | Qué ofrece | Tucumán / NOA | Contacto (URL) |
|---|---|---|---|
| **Strix Flotas** (Oleiros S.A.) | Portal y app de flotas; informes; hasta 40 eventos configurables; recupero opcional; adicionales (corte, pánico, CAN bus, temperatura) | Punto de instalación en SMT; ver arriba | https://strix.com.ar/contacto?producto=StrixFlotas ; tel. 0810-777-8749 |
| **Ituran Flotas** (Tracking / Tracking Plus) | App/web multiusuario, geozonas, histórico, recupero opcional. 24/7 | Cobertura nacional declarada | https://www.ituran.com.ar/para-flota/ ; WhatsApp ventas 116 398 4106 |
| **Albiero Seguridad** (Tucumán, +40 años) | Seguimiento GPS con central propia 24/7; comodato incluido en el servicio; instalación en menos de una hora | **Sí**: SMT, Yerba Buena, Tafí Viejo, Tafí del Valle, El Mollar | https://albiero.com.ar/seguimiento-vehicular (configurador y WhatsApp) |
| **TrailingSat S.A.** (Tucumán) | Partner Elite de Rinho Telematics; +5000 unidades, +300 clientes; minería, ADAS/DMS, WiFi; plataformas propias (StreetX, TrailingSat Visualizer) | **Sí**: Alsina 1220, SMT | https://trailingsat.com.ar ; tel. +54 9 381 623-6278 |
| **Seguridad Suat** (Tucumán) | "Control satelital de vehículos en Tucumán"; pide presupuesto | **Sí** | https://www.seguridadsuatsrl.com.ar/productos |
| **gpslomax** (Lomas de Tafí, Tucumán) | Rastreo 24/7 (solo Instagram) | **Sí** | Instagram `gpslomax`; WhatsApp 381 448-6181 |
| **COPSAT** (Santiago del Estero) | Servicio oficial Colven, CERSAT, partner Rinho | NOA, no Tucumán | https://www.copsat.com.ar |
| **ACR Seguridad Electrónica** | Rastreo vehicular en Salta y Jujuy | NOA | https://acr-seguridad.com.ar |
| **MaxTracker** (Rastreo Satelital S.A., desde 2001) | Planes Base/OBD/Pro/Premium/Enterprise (mín. 100 unidades); la grilla indica 6/12/24 meses por plan (posible permanencia, **confirmar**); lista "API para integración con sistema de gestión", "reenvío de datos a terceros" y "plataforma propia" | Nacional | https://maxtracker.com ; central 11 5263 8292 |
| **USS Flotas** (desde 1996, ISO 9001, CESVI) | Plataforma Ecotracker, central 24/7 | Nacional | https://ussflotas.com.ar ; +54 11 4011 3000 |
| **LocalSat** | Logística, seguridad, gestión de flotas; clientes con acceso a plataformas "Alpha/Delta" | `no confirmado` | https://www.localsat.com.ar |
| **GPSTEC Argentina** | Plataforma "Geolocaliza" y cámaras con video en vivo | `no confirmado` | https://www.gpstec.com.ar (solicitud de cotización) |
| **Sitrack Argentina** | Gestión de flotas y transporte seguro de carga (segmento grande) | `no confirmado` | https://sitrack.com.ar |
| **Waypoint SRL** | Seguimiento satelital y gestión de flota | `no confirmado` | https://waypoint.com.ar |
| **Satelitech S.A.** | Rosario; foco en energía, agro y trazabilidad de combustibles; no ofrece producto de flota liviana visible | No | https://www3.satelitech.com |
| **Localizar-T** | Buenos Aires; rastreo y POD | No confirmado | https://www.localizar-t.com.ar |
| **Prosegur** | Seguridad privada con sede en Tucumán; la página de vehículos devolvió 404 | Sede en Tucumán (seguridad); GPS vehicular `no confirmado` | https://www.prosegur.com.ar |
| **Wialon** (Gurtam) vía partner | Wialon Hosting/Local/Lite/Platform; cobro mensual por promedio de vehículos conectados; **precio solo bajo solicitud** | Partners en Argentina: lista de Rinho (ver arriba) | https://wialon.com/es/pricing |
| **Rinho Telematics** (red de 26 partners) | Hardware y red de partners en el país | Partners NOA: TrailingSat (Tucumán), COPSAT (Santiago del Estero) | https://www.rinho.com.ar/partners/ |

## 4. Cuentas para 11 vehículos (ilustrativas, ARS, sin IVA salvo aclaración)

- **Pixel.AR combo**: 11 × $ 6.000 = **$ 66.000/mes**, más 11 × $ 60.000 = **$ 660.000** de equipos, más instalación `no publicada`.
- **MegaTrack Básico**: **US$ 10/mes** por la flota completa (cabe en 20 dispositivos). Hay que sumar equipos y SIM de otro proveedor (p. ej. los datos de `chips.md`).
- **Strix Auto**: 11 × $ 26.000 = **$ 286.000/mes**, con instalación $ 0 y equipo en comodato. Aplica a "Strix en tu Auto"; para flotas hay que cotizar.
- **Ituran particulares**: 11 × $ 30.499 = **$ 335.489/mes**, solo de referencia.
- **Tracker.ar** (si hubiese cobertura): 11 × $ 20.000 = $ 220.000/mes en plan anual (antes del 10 % desde el segundo vehículo); **no hay cobertura en Tucumán**.

El precio de cada línea es el que muestra la web hoy. Los abonos de STRIX y otros se actualizan por mes (los T&C de Strix permiten aumentos).

## 5. GAPS (qué no se pudo cerrar)

1. **Strix Flotas**: sin precio, sin API pública hallada, sin detalle de reactivación por falta de pago. Los T&C solo dicen que la mora suspende el servicio y que la baja exige aviso de 30 días. Hay que preguntar a la empresa cuánta deuda debe saldarse y si la reactivación exige reinstalación.
2. **Ubicación de los datos** por proveedor: solo se halló dato explícito en Strix (EE. UU.), Pixel.AR (fuera de Argentina, EE. UU. y UE) y MegaTrack (sin garantía). No se supo la región de MaxTracker, Albiero ni TrailingSat. La Ley 25.326 hace relevante esta pregunta antes de contratar.
3. **API / webhooks**: solo MegaTrack la documenta. Pixel.AR, Albiero, TrailingSat, MaxTracker (la menciona en su grilla de planes), Ituran y Strix: preguntar por API, exportación y reenvío de datos a terceros en tiempo real.
4. **Compatibilidad con los equipos ya instalados (STRIX)**: no se investigó si los trackers desactivados se pueden reapuntar a otra plataforma. Probablemente sean propietarios y de la empresa (comodato).
5. **Instalación**: Pixel.AR y SmartTrack no publican el costo de instalación en el sitio. En Tucumán, Albiero informa comodato incluido sin cifras.
6. **Permanencia**: no publicada en Ituran, SPS, Albiero, TrailingSat, MaxTracker (posible 6/12/24 meses según la grilla).
7. **Un anuncio de Facebook (Bahía Blanca)** ofrecía "GPS para cualquier vehículo de tu flota. Un solo precio: $ 15.000 por vehículo, por mes". No se identificó al proveedor ni se verificó. No usar como dato.
8. **Car Security, Gpsfleet, Detektor (Argentina), Hunter (Argentina), Positron (Argentina)**: no se halló oferta de rastreo de flota con precio. Positron figura como alarmas y audio. Hunter y Detektor aparecen solo en otros países (Perú, Rep. Dominicana, Costa Rica) o en Instagram. `carsecurity.com.ar` no resolvió. `no publicado` para todos.
9. **Lista de centros de instalación** de Ituran y de Strix en Tucumán: mapas dinámicos. Solo se pudo confirmar vía buscador el Punto Strix Ricagar en SMT.
10. **Wialon en Argentina**: no se leyó lista de partners ni la ubicación de sus centros de datos (la página `/datacenter` devolvió 404).
11. **Persona de contacto, plazos de entrega, SLA y garantía** de todos: fuera de alcance, requieren contacto.

## 6. Fuentes consultadas (todas públicas, 2026-11-06)

- https://tienda.strix.com.ar ; https://strix.com.ar/empresas/flotas ; https://strix.com.ar/legales/flotas/terminos-y-condiciones ; https://strix.com.ar/promociones
- https://pixelargps.com/precios ; https://pixelargps.com/privacidad
- https://megatrackgps.app ; https://megatrackgps.app/api ; https://megatrackgps.app/privacy
- https://www.ituran.com.ar/particulares/ ; https://www.ituran.com.ar/para-flota/
- https://smarttrack.com.ar/equipos-gps/ ; https://www.tracker.ar/precio ; https://www.tracker.ar/gps-para-flotas
- https://albiero.com.ar/seguimiento-vehicular ; https://trailingsat.com.ar ; https://www.rinho.com.ar/partners/ ; https://maxtracker.com ; https://wialon.com/es/pricing
