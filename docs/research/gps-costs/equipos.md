# Hardware de rastreo GPS en Argentina: precios en ARS, instalación, estado 2G/3G y Traccar

Fecha de relevamiento: **2026-11-06**. Solo páginas públicas, sin cuentas, sin carrito, sin contactar a nadie. Toda cifra lleva su URL; lo que no se encontró figura como "no publicado".

Contexto: 11 vans (8 Kangoo, 1 Boxer, 2 Hiace), rastreo en tiempo real integrado al sistema propio (VPS en Alemania, Traccar o servidor propio). Los STRIX están desactivados por falta de pago.

## Resumen para decidir

- **Los modelos 2G puros (Teltonika FMB920/FMB120, Queclink GV300 2G, Coban TK103/TK303, Concox GT06N original) no son una buena compra hoy.** Un vendedor argentino lo dice en su propia publicación del FMB920: "REQUIERE SIM CON SERVICIO 2G ACTIVO - LAS TELEFONICAS NO ESTAN VENDIENDO LINEAS NUEVAS CON 2G ACTIVO PARA CLIENTES FINALES" (ver sección 2G/3G). Ambos están además agotados o sin stock en ML.
- **Opción profesional con precio publicado, factura A y garantía de fábrica de 12 meses:** Teltonika FMC130 a ARS 230.000 o FMC920 a ARS 190.000 (ALTA DOMOTICA, tienda oficial de ML, MercadoLíder Platinum). Ambos son LTE Cat 1 con respaldo 2G y están soportados por Traccar (protocolo `teltonika`, puerto 5027).
- **Opción económica:** Sinotrack ST-901L 4G (ARS 135.565 en la tienda oficial Sinotrack de ML) o Jimi VL502 (ARS 155.696). La compatibilidad con Traccar es menos clara (ver tabla).
- **Orden de magnitud para 11 unidades, solo equipo, con IVA** (precio de lista de ML, sin descuentos por volumen): FMC920 = 11 × 190.000 = ARS 2.090.000; FMC130 = 11 × 230.000 = ARS 2.530.000; ST-901L = 11 × 135.565 = ARS 1.491.215; Queclink GV58LAU = 11 × 283.382,63 = ARS 3.117.209. Son cuentas mías sobre los precios publicados, no cotizaciones.

## 1. Tabla de equipos y precios

Convenciones:
- **Precio** = precio de contado mostrado en la publicación el 2026-11-06, en pesos argentinos. Los precios de ML cambian a diario y algunas publicaciones muestran un precio con descuento distinto del de lista; se indica el de lista salvo aclaración.
- **IVA incluido?** En ML los precios al consumidor llegan con impuestos incluidos; ML muestra además "Precio sin impuestos nacionales". Ese valor **no es siempre precio/1,21** (ver nota debajo de la tabla). "Factura A/B" es lo que declara el vendedor en la publicación.
- **Traccar** = fila de https://www.traccar.org/devices/ (consultada el 2026-11-06): modelo → protocolo → puerto.
- Envío: todas las publicaciones de ML listadas muestran "Envío gratis" salvo que se indique otra cosa. No se calculó el envío a Tucumán (requiere ingresar un código postal, que no se hizo).

| Modelo | Red | Precio ARS | Vendedor + URL | Fecha | IVA incluido? / factura | Traccar (protocolo, puerto) |
|---|---|---|---|---|---|---|
| Teltonika **FMC920** | LTE Cat 1 + respaldo 2G, Bluetooth | 190.000 (sin imp. nacionales: 157.025) | ALTA DOMOTICA (tienda oficial, MercadoLíder Platinum, +1000 ventas). https://www.mercadolibre.com.ar/smart-gps-compacto-teltonika-fmc920-4g-2g-ideal-moto-ip54/up/MLAU222535079 | 2026-11-06 | Sí (21%: 190.000/1,21 = 157.025). "SE HACEN FACTURAS A y B". Garantía de fábrica 12 meses. Quedaban 3 unidades. No incluye SIM | `teltonika`, 5027 (Teltonika FMC920 figura en la lista) |
| Teltonika **FMC130** | LTE Cat 1 + respaldo 2G, CAN/1-Wire | 230.000 (sin imp. nacionales: 190.083) | ALTA DOMOTICA. https://www.mercadolibre.com.ar/smart-gps-tracker-rastreador-teltonika-fmc130-4g-2g/up/MLAU210721177 | 2026-11-06 | Sí (21%). Facturas A y B. Garantía 12 meses. 4 unidades. No incluye SIM | `teltonika`, 5027 |
| Teltonika FMC125 | LTE Cat 1 + 2G | 261.000 (sin imp.: 215.702) | ALTA DOMOTICA. https://www.mercadolibre.com.ar/smart-gps-tracker-rastreador-teltonika-fmc125-4g-2g/up/MLAU213620864 | 2026-11-06 | Sí. Facturas A y B | `teltonika`, 5027 |
| Teltonika FMC150 | LTE Cat 1 + 2G, CAN | 372.000 (sin imp.: 307.438) | ALTA DOMOTICA. https://www.mercadolibre.com.ar/teltonika-fmc150-rastreador-gps-avanzado-4g-2g-lee-canbus/up/MLAU359655091 | 2026-11-06 | Sí. Facturas A y B | `teltonika`, 5027 |
| Teltonika FMC650 | LTE Cat 1 | 491.000 (sin imp.: 405.785) | ALTA DOMOTICA. https://www.mercadolibre.com.ar/rastreador-gps-profesional-teltonika-fmc650-4g/up/MLAU371379822 | 2026-11-06 | Sí. Facturas A y B. Garantía del vendedor 90 días | `teltonika`, 5027 |
| Teltonika FMM80A (OBD, 4G) | LTE | 225.099 (sin imp.: 186.032) | DEL MUNDO A TUS MANOS. https://www.mercadolibre.com.ar/rastreador-gps-oculto-teltonika-fmm80a-4g-lte-obd/up/MLAU3626666571 | 2026-11-06 | Sí (21%). "Hacemos factura A o B". Se publicó también "$213.844 con cupón por seguir a la tienda" | FMM80A no figura en la lista (sí FMM920/003/150/130…, todos `teltonika`). Lo más probable es que use el mismo protocolo, **no verificado** |
| Teltonika **FMB920** | **2G solo** (SMS/2G) | 2G: publicación "no disponible por el momento", precio no visible. https://www.mercadolibre.com.ar/smart-gps-tracker-rastreador-compacto-teltonika-fmb920-2g/up/MLAU221677518 | ALTA DOMOTICA | 2026-11-06 | n/d | `teltonika`, 5027 |
| Teltonika **FMB120** | 2G | **no publicado** (sin publicaciones argentinas con precio encontradas). Stylus SA lista el FMB920 con "Consultar precio": https://www.stylus.com.ar/productos/teltonika-tele-gps-fmb920-bluetooth_16348 | — | 2026-11-06 | n/d | `teltonika`, 5027 |
| Queclink **GV58LAU** | LTE Cat 4 (respaldo 3G/2G), BLE 5.2 | 283.382,63 (sin impuestos: 234.200,52; ver nota; en la lista de Google figuraba 281.918,82) | RASTREOMOBILE (tienda web, CABA). https://rastreomobile.com.ar/productos/rastreador-mini-lte-cat-4-queclink-gv58lau/ | 2026-11-06 | Sí (21%: 283.382,63/1,21 = 234.200,52). Factura: no declarada en la ficha. "5% de descuento pagando con transferencia"; 24 cuotas de 28.338,26. El abono de servicio de su plataforma se vende aparte | `gl200`, 5004 (GV58LAU, GV58CG, GV58CEU) |
| Queclink GV57CG | LTE Cat 1 | 214.788,75 | RASTREOMOBILE. https://rastreomobile.com.ar/rastreadores-satelitales/queclink/ | 2026-11-06 | Presumiblemente igual que el GV58LAU (no verificado en la ficha) | `gl200`, 5004 |
| Queclink GV350MG | LTE | 447.824,80 | RASTREOMOBILE. https://rastreomobile.com.ar/rastreadores-satelitales/queclink/ | 2026-11-06 | ídem | `gl200`, 5004 |
| Queclink GV310LAU | LTE Cat 4 | 390.319,16 | RASTREOMOBILE (misma URL) | 2026-11-06 | ídem | `gl200`, 5004 |
| Queclink **GV300** (2G) | 2G | Publicación "no disponible por el momento". https://www.mercadolibre.com.ar/gps-tracker-queclink-wireless-gv300-2g/up/MLAU3890614632 | vendedor particular (1 vendido) | 2026-11-06 | n/d | `gl200`, 5004 |
| Queclink GL320MG (kit Spyspot) | LTE | 452.717 (sin imp.: 364.726) | GLIC. https://www.mercadolibre.com.ar/kit-de-seguimiento-spyspot-4g-queclink-gl320mg/up/MLAU3155399227 | 2026-11-06 | Sí. Factura: no declarada. La descripción habla de plan de servicio en USD (producto de rastreador personal, no vehicular) | no figura GL320MG en la lista consultada |
| Jimi/Concox **VL502** (OBD, LTE Cat 1) | LTE | 155.696 (sin imp.: 140.901) | argseguridad. https://www.mercadolibre.com.ar/gps-4g-tracker-concox-jimi-vl502-obdii/up/MLAU5211285566 | 2026-11-06 | Sí. "Hacemos Factura A y B" (tener CUIT cargado en ML). Garantía 12 meses. 3 vendidos | `jt808`, 5015 (Jimi IoT VL502) |
| Jimi VL04L (OBD, audio) | LTE | 139.281 | argseguridad. https://www.mercadolibre.com.ar/gps-4g-tracker-concox-jimi-vl04l-audio-obd-ii/up/MLAU5211296310 | 2026-11-06 | ídem | la lista trae JM-VL04 (`gt06`, 5023); el VL04L no figura exacto |
| Jimi **VL110C** (hardwired 9-90 V, "homologado") | LTE | 69.000 | vendedor sin nombre visible. https://www.mercadolibre.com.ar/gps-rastreador-jimi-iot-vl110c-vehicular-4g-homologado-9-90v/up/MLAU4608475594 | 2026-11-06 | n/d | `gt06`, 5023 (Jimi IoT VL110C) |
| Concox **GT06E 4G** | 4G (clon; ver GAPS) | 86.005 (con descuento mostrado 74.993; sin imp.: 61.978) | Conecty (+1000 vendidos). https://www.mercadolibre.com.ar/gps-tracker-rastreador-concox-gt06e-4g-autos-motos-camiones/up/MLAU3540129878 | 2026-11-06 | "Hace Factura A". Garantía 12 meses | `gt06`, 5023 (Concox GT06E) |
| Concox **GT06N** | 2G | no hallado como publicación individual en ML | — | 2026-11-06 | — | `gt06`, 5023 |
| Jimi **JM-VL03** | 2G/4G según variante | no hallado | — | 2026-11-06 | — | `gt06`, 5023 (JM-VL03) |
| Concox **X3** | — | no hallado (la búsqueda "concox x3" trae otro producto: "Easytrack Tarjeta inteligente GPS Android X3", 139.564, EASY TRACK) | https://www.mercadolibre.com.ar/easytrack-tarjeta-inteligente-gps-android-x3/up/MLAU3895866103 | 2026-11-06 | — | `gt06` figura "Concox CRX3", no X3 exacto |
| Coban **TK103A** | 2G | 208.499 (sin imp.: 172.313) | DEL MUNDO A TUS MANOS. https://www.mercadolibre.com.ar/rastreador-gps-vehicular-coban-tk103a-antirrobo-en-tiempo/up/MLAU3213633568 | 2026-11-06 | Sí. "Hacemos factura A o B". Otro vendedor: AIRDROPY 238.108 (https://www.mercadolibre.com.ar/coban-gps-gprs-sms-real-time-tracker-tk103a-quad-band-sd-car/p/MLA48299472); GLIC 210.143 | `tk103`, 5002 (Coban TK103A/B); `gps103`, 5001 (TK103-2B, TK303B/G) |
| Coban TK303F/GPS303G | 2G | 136.223 / 90.000 | sin vendedor visible. https://www.mercadolibre.com.ar/gps-tracker-localizador-para-carros-o-motos-coban-303f-color-gris/p/MLA35961951 | 2026-11-06 | n/d | `gps103`, 5001 (TK303B/G) |
| SinoTrack **ST-901L** (4G, relé de corte) | LTE Cat 1 | 135.565 (en la página aparece también 120.133 con 11% OFF; sin imp.: 108.718) | Sinotrack (tienda oficial en ML, +100 vendidos). https://www.mercadolibre.com.ar/gps-tracker-sinotrack-st-901l-4g-rastreador-vehiculos-con-rele-corte-de-corriente/p/MLA49764491 | 2026-11-06 | Sí. Factura: no declarada. Garantía de fábrica 3 meses. Otras ofertas del mismo producto: 101.004 (https://www.mercadolibre.com.ar/localizador-gps-sinotrack-st-901l-4g-for-vehiculos-a-prueba/p/MLA2121479732), 112.027, 103.285, DEL MUNDO A TUS MANOS 204.799 | `h02`, 5013 para "Sinotrack ST-901"; "ST-901 A+" y "ST-902W" van por `jt808`, 5015. **Para la variante 901L 4G no hay fila exacta** |
| SinoTrack **ST-906L** | LTE | 219.799 (con cupón por seguir tienda: 208.809; sin imp.: 181.652) | DEL MUNDO A TUS MANOS. https://www.mercadolibre.com.ar/rastreador-gps-4g-sinotrack-st-906l-antirrobo-para/up/MLAU3634397166 | 2026-11-06 | Sí (21%). "Hacemos factura A o B". Otra oferta: 99.467 (https://www.mercadolibre.com.ar/localizador-gps-sinotrack-st-906l-4g-antirrobo-para-vehiculo/p/MLA2052185353) | ST-906 **no figura** en la lista de Traccar; sin protocolo confirmado |
| Meitrack (T333, etc.) | — | **no publicado** como rastreador vehicular. Solo aparecen botones de pánico/relojes Meitrack a 328.102–1.058.148 (JR INGENIERIA, productos integra) | https://www.mercadolibre.com.ar/boton-antipanico-gsm-sms-hombre-caido-ancianos-remoto/up/MLAU157794444 | 2026-11-06 | — | `meitrack`, 5020 (MVT, T1/T3, T333L, T399L, T633L, etc.) |
| Ruptela (Eco5, Pro5, etc.) | — | **no publicado** en ARS (la búsqueda en ML no trae resultados) | — | 2026-11-06 | — | `ruptela`, 5046 |
| Teltonika (todos los de Tokioba) | — | **precio oculto**: "Inicie sesión para ver los precios" (FMC130, FMC920, FMC003, FMC150, FMC650, etc.). Tokioba es "distribuidor oficial", CABA, ventas@tokioba.com. https://tiendateltonika.com.ar/productos/ | — | 2026-11-06 | — | `teltonika`, 5027 |

### Notas a la tabla

1. **"Precio sin impuestos nacionales"**: para ALTA DOMOTICA, RASTREOMOBILE y DEL MUNDO A TUS MANOS equivale exactamente a precio/1,21, es decir, IVA 21% incluido en el precio de lista. En otras publicaciones el cociente es distinto (Jimi VL502: 155.696 → 140.901, cociente 1,105; Sinotrack ST-901L: 1,247; Conecty GT06E: 1,388), así que ahí ML descuenta otros impuestos o tasas diferentes. **Para un presupuesto con crédito fiscal de IVA conviene tomar solo las publicaciones que declaran "Factura A" y pedir confirmación del importe neto.** No lo confirmé con ningún vendedor.
2. Los precios de ML se mueven a diario; la misma publicación de la ST-901L muestra 135.565 de lista y 120.133 con descuento. Volver a consultar el día de la compra.
3. El segundo y tercer vendedor por modelo solo existe para Sinotrack ST-901L/ST-906L, Coban TK103A y, parcialmente, Teltonika FMM80A. **Para FMC920/FMC130 (los candidatos más serios) ALTA DOMOTICA es el único vendedor con precio publicado**; el otro canal es el distribuidor Tokioba, con precio oculto tras login (no se creó cuenta).
4. Los datos de la columna Traccar salen de https://www.traccar.org/devices/ y dicen qué protocolo y puerto por defecto usa el servidor, no garantizan que cada variante regional funcione sin ajustes.

## 2. 2G/3G en Argentina (estado a 2026-11-06)

Resumen: **no hay una fecha oficial de apagado nacional publicada que haya encontrado**, y las fuentes se contradicen en detalles. Lo único consistente es que el 2G se está retirando de a poco y que las líneas 2G ya no se venden a clientes finales. Los dispositivos de 4G Cat 1/Cat 4 son los que no tienen riesgo.

| Operador | 2G | 3G | Fuente | Calidad de la fuente |
|---|---|---|---|---|
| Movistar | "apagó su red 2G el 31 de diciembre de 2023"; los rastreadores solo-2G con chip Movistar dejaron de transmitir desde el 1/1/2024 | no indica | https://www.odiseaestore.com/cobertura-4g-en-argentina-para-rastreado (publicado 4 jul 2026) | tienda de GPS, fuente comercial secundaria |
| Personal (Telecom) | "mantiene la red 2G activa" y "está discontinuando la red 3G" porque habilitó VoLTE | 3G: iot.cards dice "Apagada: 2023"; DPL News (2 may 2025) la lista como 3G 2024 | https://www.odiseaestore.com/cobertura-4g-en-argentina-para-rastreado ; https://iot.cards/es/recursos/guias/sunset-3g ; https://dplnews.com/el-ocaso-de-las-redes-legacy-para-dar-lugar-a-las-de-nueva-generacion/ | las fechas de 3G de Personal **no coinciden** entre fuentes (2023 vs 2024) |
| Claro | "no ha confirmado públicamente una fecha de apagado 2G"; iot.cards: sin fecha | iot.cards: "Sin fecha"; KORE (resultado de Google, 7 may 2026) lista "CLARO ARGENTINA, 3G, 31/12/2025" | https://iot.cards/es/recursos/guias/sunset-3g ; https://www.korewireless.com/es/network-sunsets/ | KORE y iot.cards **se contradicen** en 3G de Claro; no pude abrir la tabla de KORE |

Otros datos:
- Telecom Argentina (mayo 2024): "Por ahora no tienen planificado apagar 2G, dijeron, debido a que aún tienen usuarios M2M en esa red" (DPL News). https://dplnews.com/telecom-argentina-espera-cerrar-2024-260-sitios-5g/
- iot.cards, tabla 2G por país (8 ago 2026), Argentina: "Movistar / Claro / Personal · Sin fecha". https://iot.cards/es/recursos/guias/sunset-2g
- Un comentario en r/AskArgentina de hace unos 4 meses: "Personal y Claro siguen manteniendo sus redes 2G" (no es fuente fiable, solo orientativo). https://www.reddit.com/r/AskArgentina/comments/1uosskp/siguen_habiendo_redes_2g_en_argentina/
- Aviso del propio vendedor Alta Domotica (descripción del FMB920 2G, ML): las telefónicas no venden líneas nuevas con 2G activo a clientes finales; el servicio 2G se sigue ofreciendo en SIM M2M que se venden solo por canal de empresas (clientes con CUIT). https://www.mercadolibre.com.ar/smart-gps-tracker-rastreador-compacto-teltonika-fmb920-2g/up/MLAU221677518
- Un artículo de LinkedIn (USS Seguridad Integral, "hace 1 mes") afirma que el apagado "ya está en marcha en Argentina" y es gradual, pero no da fechas por operador: https://es.linkedin.com/pulse/el-apagado-de-las-redes-2g-y-3g-lo-que-significa-9mnef
- **Descartado:** un resultado de Convergencia Latina sobre "consulta pública para el apagado de 2G y 3G" (18 dic 2025) trata de España (Telefónica, MasOrange, Vodafone), **no de Argentina**. No lo usé como evidencia.
- No encontré ninguna resolución del ENACOM que fije fechas de apagado 2G/3G (las resoluciones ENACOM que aparecieron en la búsqueda tratan de otros temas: registro de materiales, bloqueo de equipos, programa CIP).

**Implicancia para la compra:** FMC920/FMC130 (LTE Cat 1 con respaldo 2G), Queclink GV58/GV57 (Cat 1/Cat 4), Jimi VL502 y Sinotrack ST-901L/906L 4G funcionan en 4G y no dependen del 2G. Los FMB920/FMB120/GV300/TK103/TK303/GT06N originales son solo 2G y quedan descartados salvo que el operador del SIM M2M garantice 2G.

## 3. Instalación por vehículo

No se encontró ningún precio publicado de instalación específico de **San Miguel de Tucumán**. Lo publicado en el país:

| Servicio | Precio ARS | IVA | Fuente | Fecha |
|---|---|---|---|---|
| Instalación GPS básica (RASTREOMOBILE, CABA) | 93.717,22 | precio de lista con IVA (el sitio muestra "Precio sin impuestos" para sus productos; para este en particular el listado solo trae el final) | https://rastreomobile.com.ar/instalaciones-gps/ | 2026-11-06 |
| Instalación GPS con sensores (RASTREOMOBILE) | 157.283,10 (sin impuestos: 129.986,03); en el resultado de Google figuraba 155.900,00 | incluido | https://rastreomobile.com.ar/productos/instalacion-gps-con-sensores/ | 2026-11-06 |
| Instalación a domicilio, tracker.ar (servicio, CABA/GBA) | 0 con turno, dentro de un abono de 28.000/mes | n/d | https://www.tracker.ar/guias/cuanto-cuesta-un-gps-para-auto | 2026-11-06 |
| Pixel.AR GPS (empresa con teléfono +54 381, Tucumán): "Rastreador 4G completo" | 60.000 pago único ("Instalación no incluida") | n/d | https://pixelargps.com/ | 2026-11-06 |
| America GIS (kit autoinstalable) | 36.179 por unidad con IVA incluido; "Kit + abono anual" 319.000 | sí | https://americagis.com.ar/tienda.html | 2026-11-06 |
| SPS (kit de rastreo con instalación profesional) | 60.499 con IVA (sin impuestos 49.999,17) | sí | https://www.sps.com.ar/tienda/vehiculos/seguridad-vehicular/seguridad-vehicular | 2026-11-06 |
| Instalación a domicilio por técnicos en Tucumán | **no publicado**. America GIS indica que tiene técnicos en Tucumán, pero sin precio (https://www.americagis.com.ar/tecnicos-instaladores.html) | — | — | 2026-11-06 |

Proveedores locales detectados en Tucumán, sin precios en sus sitios: Trailingsat S.A. (Alsina 1220, partner oficial Rinho Telematics; https://trailingsat.com.ar/), Albiero Seguridad (https://albiero.com.ar/seguimiento-vehicular; dice que el equipo se instala en menos de una hora, sin precio), Sistema de Seguimiento Satelital SRL (Colombia 1061, Páginas Amarillas, sin precio), Pixel.AR GPS.

Lectura: el precio de lista más cercano de una instalación profesional "básica" es **ARS 93.717,22 por vehículo** (RASTREOMOBILE, Buenos Aires; no es Tucumán). Para 11 vans serían ARS 1.030.889 si se aplicara ese precio. Es una extrapolación mía; el costo real en Tucumán hay que pedirlo por cotización.

Servicios de terceros mencionados al pasar (no son hardware, pero ayudan a comparar con el STRIX): tracker.ar 28.000/mes por vehículo con equipo e instalación incluidos (CABA/GBA); SPS 26.344,72/mes IVA incluido; America GIS 19.800 + IVA/mes; un grupo de Facebook ofrece "15.000 por vehículo por mes". Esas cifras salen de resultados de Google (la de Facebook no la verifiqué en la página).

Conectividad (SIM M2M), por si sirve para el total: Pixel.AR publica "Chip M2M $2.000/mes, 25 MB/mes incluidos, cobertura nacional" (https://pixelargps.com/, 2026-11-06). No relevé SIM de otras operadoras; está fuera del alcance de esta nota.

## 4. GAPS (lo que no se pudo cerrar)

1. **FMB920/FMB120**: sin precio vigente (el FMB920 en ML está no disponible; Stylus pide "Consultar precio"). Además son 2G.
2. **Teltonika vía Tokioba** (distribuidor oficial): precios solo con login; no se creó cuenta. Es la fuente que probablemente ofrezca factura A formal y descuento por 11 unidades, pero no tiene precio público.
3. **FMC920/FMC130**: un solo vendedor con precio público (ALTA DOMOTICA). No hay segundo vendedor en ML. No se verificó el costo de envío a Tucumán.
4. **Queclink GV300 (2G) y GV58 en ML**: el GV300 está agotado; GV58LAU solo en RASTREOMOBILE (no en ML). No hallé GV350 en ML con precio propio (aparece GV350MG en RASTREOMOBILE a 447.824,80).
5. **Concox GT06N, Jimi JM-VL03, Concox X3**: sin publicaciones identificables; en ML aparecen clones genéricos ("GT06E 4G", J16, etc.) cuya identidad de hardware real no se puede comprobar desde la publicación. El "Concox GT06E 4G" de Conecty a 86.005 puede ser un clon; **cuidado**, no verifiqué la marca real.
6. **Ruptela y Meitrack vehiculares**: sin precio público en ARS en Argentina.
7. **Sinotrack ST-901L (4G) y ST-906L**: no hay fila exacta en Traccar (ST-901 → `h02`; ST-901 A+ y ST-902W → `jt808`). Hay que probar el equipo con el servidor antes de comprar 11.
8. **IVA/factura**: para varios vendedores (Sinotrack oficial, GLIC, RASTREOMOBILE, AIRDROPY) la publicación no declara factura A; no se les preguntó.
9. **Instalación en Tucumán**: ningún precio publicado. Hay que pedir cotización a Trailingsat, Albiero o Pixel.AR (no lo hice: reglas de la tarea).
10. **Estado 2G/3G**: sin fuente oficial (operadora o ENACOM); las fechas de Personal 3G y Claro 3G son contradictorias entre fuentes secundarias. No se verificó la cobertura LTE en Tucumán ni en las rutas del servicio.
11. No relevé cupones de volumen ni comparé cuotas/financiación; los precios son de contado.
