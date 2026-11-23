# Plataformas de tracking GPS y celular como tracker: costos y límites

Fecha de relevamiento: **2026-11-06** (todas las páginas se leyeron ese día con ego-browser, solo lectura pública; no se creó cuenta ni se pidió cotización).

Contexto: empresa de traslado de pasajeros en San Miguel de Tucumán, 11 vans (8 Kangoo, 1 Boxer, 2 Hiace), tracking en tiempo real integrado a su sistema propio (web app autohospedada en un VPS en Alemania). Los STRIX están dados de baja por falta de pago. Ley 25.326: la transferencia de datos personales a países sin protección adecuada está restringida (UE/UK adecuados; EE. UU. y Brasil no).

Para 11 unidades: la columna "11 unidades/mes" se calcula como 11 × precio publicado, solo cuando hay precio por unidad publicado.

---

## 1. Plataformas de tracking para trackers de terceros

| Plataforma | Precio unidad/mes (moneda) | Plan base/mínimo | Región de datos | API | URL | Fecha |
|---|---|---|---|---|---|---|
| **Traccar autohospedado** (software libre) | USD 0 de licencia; costo = VPS propio (Traccar estima "USD 5-20/mes" de VPS) | Sin mínimo; sin límite de dispositivos por licencia | La que elijas ("tu propio servidor, tu región"); el VPS en Alemania ya cumple UE | REST + WebSocket (documentados en "Traccar API") | https://www.traccar.org/managed-vs-self-hosted/ y https://www.traccar.org/documentation/ | 2026-11-06 |
| **Traccar Tracking Account** (hosting gestionado, servidor compartido) | No es por unidad: tarifa fija por tramo. USD 9.95/mes (límite 5 dispositivos); tramo de 20 dispositivos: la página no mostró el precio (el selector falla en la página de detalle); un resultado de Google lo muestra como "Desde USD 9.95 hasta USD 19.95" | USD 9.95/mes (5 disp.); 7 días de prueba gratis. Una sola cuenta de usuario, sin admin ni marca | "Infraestructura operada por Traccar"; **región no publicada** | REST + WebSocket con permisos de usuario normal; 1 año de historial | https://www.traccar.org/pricing/ ; https://www.traccar.org/product/tracking-account | 2026-11-06 |
| **Traccar Tracking Server** (servidor dedicado gestionado) | Tarifa fija: desde USD 49.95/mes (límite 50 dispositivos; hay tramos 100/200/500/1000 sin precio visible en el texto) | USD 49.95/mes, 50 disp.; usuarios ilimitados, marca y dominio propios, 1 año de historial | **No publicada** | REST + WebSocket | https://www.traccar.org/pricing/ ; https://www.traccar.org/product/tracking-server | 2026-11-06 |
| **GPS-Trace (Forguard)** (Gurtam) | EUR 0.30 / 0.60 / 0.90 / 1.20 por unidad/mes según plan (Starter / Lite / Lite+ / Advanced). 11 unidades: EUR 3.30 / 6.60 / 9.90 / 13.20 | Sin mínimo de volumen ni paquetes; se cobra por día y por vehículo. Starter sin notificaciones ni eventos; Lite desde EUR 0.60 incluye notificaciones, eventos, timeline | **No encontré dato publicado** (Gurtam opera los datacenters de Wialon/GPS-Trace en Países Bajos, EE. UU. y Arabia Saudita; no se confirma cuál usa GPS-Trace) | Sí: Platform API con token (header `X-AccessToken`) para proveedores de servicio ("Console"); no se confirmó acceso para cliente final | https://gps-trace.com/en/forguard ; https://gps-trace.com/en/integrations | 2026-11-06 |
| **flespi** (hub telemático, sin UI de flota) | Plan "Commercial" desde EUR 130/mes (Start) con 1000 dispositivos incluidos; extras EUR 0.02 por cada 1000 dispositivos adicionales; plan Free: EUR 0, 10 dispositivos, 2 canales, 1 stream, límites no extensibles | Free (10 disp.) para pruebas; el primer plan pago es EUR 130/mes. flespi indica "efectivo ~EUR 0.20/dispositivo" para ~1.000 dispositivos | Una sola región "EU": 2 datacenters en Países Bajos; operada por UAB Gurtam (Lituania), cubierta por GDPR | REST + MQTT + streams (el producto es la API) | https://flespi.com/pricing ; https://flespi.com/kb/regions-geographically-distributed-flespi-datacenters | 2026-11-06 |
| **Wialon Hosting** (Gurtam) | **No publicado.** Gurtam no vende al usuario final; vende por partners ("Wialon works through a global partner network, not directly with fleet owners"). Precio por vehículo/mes lo fija cada partner | Sin precio publicado; hay descuentos por volumen/funciones para los partners | Datacenters de Gurtam: Países Bajos, EE. UU., Arabia Saudita | Sí (Wialon Remote API / SDK; la página wialon.com/en/api devolvió contenido mínimo, no leí el detalle) | https://wialon.com/en/pricing ; https://wialon.com/en/datacenter | 2026-11-06 |
| **Navixy** | **No publicado** ("Request Pricing & Plan"). Precio por activo rastreado + uso (modelo estilo AWS). Directorios de terceros listan planes de USD 250/500/1000 por mes (Software Finder, 2025-10-06) sin confirmar en el sitio oficial | Sin mínimo publicado | Sitio oficial: almacenamiento regional "Europa, Américas, Asia-Pacífico", con elección de residencia en el onboarding. Un resumen de Google indica EU en AWS Frankfurt y EE. UU. para las Américas; **no verificado en página primaria** | Sí (Developer Hub / API y documentación) | https://www.navixy.com/pricing/ ; https://navixy.com/es/legal/data-residency/ | 2026-11-06 |
| **GPSWOX** (SaaS) | Lite USD 3.67/mes (pago anual, 1 objeto); Basic USD 12/mes (anual, 1-5 objetos); Pro USD 59/mes (mensual, 1-50 objetos); White label desde USD 129/mes (mensual, 1-50). Para 11 unidades el plan que entra es Pro (USD 59/mes, ~USD 5.36 por unidad) | Lite (1 objeto) | No publicada en la página de precios. Política de privacidad: cumple GDPR; empresa registrada en Londres con oficina en Vilnius. Un resumen de Google dice servidor Europa en Hetzner Alemania: **no verificado** | La tabla de precios lista "API access" como fila; qué planes la incluyen no se pudo leer (tabla aplanada en texto) | https://www.gpswox.com/en/pricing | 2026-11-06 |
| **Otros** (Hubstaff, Workyard, Onfleet, Connecteam) | Ver sección 2: no son plataformas de trackers de terceros, son apps de personal/entregas | — | — | — | — | — |

Notas sobre integración con el sistema propio:
- El hecho de que el routing sea propio inclina a Traccar autohospedado (mismo VPS en Alemania, sin transferencia internacional, API/WebSocket abiertos) o a flespi (hub puro, UE/Países Bajos) frente a plataformas con UI propia.
- GPS-Trace es la opción pagada más barata con precio por unidad publicado, pero hay que confirmar región de datos y acceso a API para cuenta final.

### Ejemplo de costo mensual para 11 unidades (solo con precios publicados)

| Opción | USD / EUR | ARS aprox. (sin impuestos) | Fuente del tipo de cambio |
|---|---|---|---|
| Traccar autohospedado | USD 0 + VPS (aparte) | VPS aparte | — |
| Traccar Tracking Account (20 disp., si USD 19.95) | USD 19.95 | ~31 300 (oficial BNA 1570) | BNA 2026-11-05 |
| Traccar Tracking Server (50 disp.) | USD 49.95 | ~78 400 | BNA 2026-11-05 |
| GPS-Trace Starter…Advanced | EUR 3.30–13.20 | ~5 900–23 800 (euro billete BNA venta 1800) | BNA 2026-11-05 |
| flespi Start | EUR 130 | ~234 000 | BNA 2026-11-05 |
| GPSWOX Pro | USD 59 | ~92 600 | BNA 2026-11-05 |

Los importes en pesos son solo conversión; ver sección 3 para impuestos y percepciones que se suman al pagar con tarjeta argentina.

---

## 2. Celular como tracker (sin hardware)

| Opción celular | Costo | Limitaciones | Fuente |
|---|---|---|---|
| **Traccar Client** (Android e iOS, app oficial) | Gratis, código abierto, sin anuncios. Google Play: 500 mil+ descargas, 4.8 (17 mil opiniones). Envía a tu propio servidor Traccar o a plataformas compatibles (protocolo OsmAnd) | Android: necesita permiso de ubicación precisa y en segundo plano, permiso de actividad física, y excepción de optimización de batería; fabricantes con ahorro propio pueden matarla (guía oficial remite a dontkillmyapp). iOS: al cerrar la app deslizándola, el proceso muere y deja de reportar; requiere ubicación "Siempre" y ejecución en segundo plano permitida. Por defecto detecta paradas y pausa los reportes (hay "stationary heartbeat", desactivado por defecto). Con buffer offline reintenta; sin buffer descarta. Hay SDK para apps nativas Android/iOS, Flutter y React Native | https://www.traccar.org/client/ ; https://www.traccar.org/client-troubleshooting/ ; https://play.google.com/store/apps/details?id=org.traccar.client |
| **GPSLogger** (solo Android) | Gratis | Registra a GPX/KML/CSV/NMEA y puede subir a "Custom URL" y otros destinos a intervalos. No existe para iOS. No es un tracker en tiempo real "listo" para flota: se integra vía URL propia | https://gpslogger.app/ |
| **OsmAnd** (Online tracking) | App gratuita (funciones del plugin de grabación; no verifiqué el costo de planes) | La función "Online tracking" (enviar puntos a una URL) está indicada solo para **Android**; el manual de OsmAnd avisa que iOS puede suspender la app y cortar la grabación | https://osmand.net/docs/user/plugins/trip-recording/ |
| **Workyard** (control horario con GPS) | Desde USD 6 por usuario/mes (facturación anual) | Producto de horas y asistencia de cuadrillas (ubicación y kilometraje), no de tracking de flota en vivo ni de tu propio sistema | https://www.workyard.com/pricing |
| **Hubstaff** | Desde USD 4.99 / 7.50 / 10 / 25 por asiento/mes (planes Starter/Grow/Team/Enterprise), mínimo 2 asientos | Foco en tiempo y productividad; no confirmé qué plan trae GPS | https://hubstaff.com/pricing |
| **Onfleet** (despacho de entregas) | Desde USD 619/mes (Launch, hasta 2.500 entregas/mes) | Pensado para entregas de última milla; muy por encima del tamaño de esta flota y de los datos propios | https://onfleet.com/pricing |
| **Connecteam** | Planes desde USD 29/mes más USD 0.8–3 por usuario adicional; hay plan gratis | App de gestión de equipos con "GPS clock in/out"; no es tracking continuo de vehículos | https://connecteam.com/pricing/ |
| **App propia con Traccar Client SDK o app nativa** | Costo de desarrollo (no cotizado) | Es la única vía realmente continua en ambos sistemas (ver abajo) | https://www.traccar.org/client/ |

### Límites de plataforma para ubicación continua en celular

| Tema | Qué dicen las fuentes oficiales | Fuente |
|---|---|---|
| **Web/PWA, cualquier navegador** | La especificación W3C Geolocation dice que las actualizaciones de posición se entregan "exclusivamente a documentos completamente activos y **visibles**; de lo contrario se descartan silenciosamente". Es decir, una web app/PWA no puede seguir enviando posición con pantalla bloqueada o en segundo plano | https://www.w3.org/TR/geolocation/ (nota "Position updates are exclusively for fully-active visible documents") |
| **Mantener pantalla encendida (Wake Lock)** | La Screen Wake Lock API solo la obtienen documentos activos y visibles; se libera automáticamente cuando el documento deja de estar activo/visible, por batería baja o ahorro de energía. Sirve de parche (pantalla siempre prendida con la app en primer plano), no de solución en segundo plano | https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API |
| **Background Sync periódico** | Es API "experimental" y no Baseline (no funciona en navegadores muy usados); además es de sincronización de datos, no de ubicación | https://developer.mozilla.org/en-US/docs/Web/API/Web_Periodic_Background_Synchronization_API |
| **iOS: PWA en pantalla de inicio** | WebKit documentó para las web apps de pantalla de inicio (iOS 16.4) Web Push, notificaciones y Badging API. **No hay en esa publicación ni en las páginas de MDN consultadas ninguna capacidad de geolocalización en segundo plano para web apps** | https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ |
| **iOS nativo** | Apple: el sistema suspende la mayoría de las apps poco después de pasar a segundo plano y no entrega ubicaciones mientras están suspendidas. Para recibirlas hay que habilitar la capacidad "Location updates" (modo de fondo) y crear una `CLBackgroundActivitySession`/`CLServiceSession` (autorización "when in use" o "always") | https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background |
| **Android nativo** | Android: desde 8.0 (API 26), si la app corre en segundo plano recibe actualizaciones de ubicación solo "algunas veces por hora"; requiere `ACCESS_BACKGROUND_LOCATION` (Android 10+). La alternativa es un **servicio en primer plano** de tipo `location` (con notificación visible); no se puede iniciar mientras la app está en segundo plano salvo que tenga el permiso de ubicación en segundo plano. Google Play restringe el permiso de ubicación en segundo plano a apps que lo necesiten para su función principal | https://developer.android.com/develop/sensors-and-location/location/background ; https://developer.android.com/develop/background-work/services/fgs/service-types |

Conclusión técnica del relevamiento: para ubicación continua con el celular en el bolsillo hace falta app **nativa** (Traccar Client, SDK propio) con permiso "Siempre"/segundo plano; una PWA solo transmite mientras esté visible, y en iOS no hay camino documentado para hacerlo en segundo plano.

---

## 3. Tipos de cambio e impuestos (Argentina, 2026-11-06)

### Tipos de cambio

| Cotización | Compra | Venta | Fecha/hora de la fuente | Fuente |
|---|---|---|---|---|
| Dólar oficial Banco Nación (billete) | 1520,00 | **1570,00** | 5/11/2026, actualización 17:00 (última publicada en la página al leer) | https://www.bna.com.ar/Personas |
| Euro billete Banco Nación | 1700,00 | 1800,00 | 5/11/2026 17:00 | https://www.bna.com.ar/Personas |
| Dólar MEP ("bolsa") | 1560,20 | **1587,90** | 2026-11-06 21:00 UTC | https://dolarapi.com/v1/dolares (agregador; no es fuente oficial) |
| Dólar MEP (Ámbito, vía resumen de Google) | — | ~1578,78 | cierre 6/11/2026 | resultados de Google de Ámbito/Perfil; no abrí la nota original |
| Dólar tarjeta | 1976 | **2041** | 2026-11-05 18:00 UTC | https://dolarapi.com/v1/dolares ; Google/Ámbito/La Nación coinciden en 2.041 |
| Dólar mayorista | 1536,5 | 1545,5 | 2026-11-06 15:35 UTC | https://dolarapi.com/v1/dolares |

El dólar tarjeta (2041) equivale a 1570 × 1,30, es decir, oficial BNA venta más 30 %.

### Impuestos y percepciones sobre servicios digitales del exterior pagados con tarjeta argentina

- **Percepción RG 5617/2024 de ARCA: alícuota 30 %** sobre el importe total de cada operación alcanzada, a cuenta de Ganancias o Bienes Personales. Alcanza el "cambio de divisas para el pago de servicios prestados por no residentes que se cancelen con tarjeta de crédito, de compra y de débito", en la medida en que se abonen en pesos. Tipo de cambio: **vendedor del Banco de la Nación del día hábil anterior** a la emisión del resumen. Excluye salud, libros/educación, gaming (desde 16/04/2025), entre otros. Es un pago a cuenta: si no sos contribuyente de esos impuestos, se puede pedir la devolución. Fuente primaria: https://www.afip.gob.ar/regimen-devolucion-percepciones/percepcion/ y https://www.afip.gob.ar/regimen-devolucion-percepciones/percepcion/operaciones.asp y `/importe.asp` (leídas 2026-11-06).
- **Contradicción en fuentes secundarias:** varias notas (Mundo Empresas del 2/1/2026, resúmenes de Google) dicen que ARCA eliminó el 30 % desde el 2/1/2026 salvo turismo. La página oficial de ARCA leída hoy sigue describiendo el 30 % sin fecha de fin, y los cotizadores de mercado de hoy siguen publicando dólar tarjeta = oficial × 1,30. La nota de Mundo Empresas además afirma que el impuesto PAIS seguía vigente en diciembre de 2025, cuando había vencido en 2024, por lo que la tomo como poco confiable. **Tratar el 30 % como vigente hasta verlo en un resumen de tarjeta real.**
- **Impuesto PAIS:** ya no rige (venció en diciembre de 2024), según resúmenes secundarios (askmonarca.com / Google); no lo verifiqué en el texto oficial.
- **IVA 21 % servicios digitales del exterior** y **Ingresos Brutos provinciales**: citados por fuentes secundarias (Estudio Piacentini, Banco Galicia vía Google) como aplicables además de la percepción; no los verifiqué en ARCA ni en Rentas Tucumán. Si la empresa es responsable inscripta, el tratamiento del IVA (crédito fiscal) cambia el costo neto.
- **Evitar el 30 %:** pagar el resumen con dólares propios (descrito por Banco Galicia/Monarca en resultados de Google; no verifiqué en banco emisor concreto).

Ejemplo de costo efectivo en pesos para USD 19.95/mes con tarjeta en pesos (sin IVA ni IIBB): 19,95 × 1570 × 1,30 = ~40 720 ARS. Con IVA 21 % sobre el precio base (si aplica): ~+6 580 ARS (21 % de 31 330) adicionales, según criterio fiscal a confirmar.

---

## GAPS

1. **Traccar Tracking Account, tramo de 20 dispositivos:** precio no visible en el texto de la página (error de render al leer el selector); solo el rango "USD 9.95 a 19.95" de un resultado de Google. Falta confirmar cuánto cuesta el tramo que cubre 11 vans.
2. **Traccar managed / Tracking Server:** región de datos no publicada; relevante para Ley 25.326 (si el servidor gestionado está en EE. UU., hay transferencia a país sin adecuación).
3. **Wialon:** sin precio público; no pude listar partners argentinos (el buscador de partners es un mapa dinámico). Hace falta cotización de un partner local.
4. **Navixy:** sin precio público; la región EU/Frankfurt viene de un resumen de Google, no de página primaria.
5. **GPS-Trace:** región de datos y si el cliente final (no proveedor) accede a la API no están claros; pidió cuenta de proveedor para probar.
6. **GPSWOX:** qué planes incluyen API y región del servidor no verificadas.
7. **Apps de conductor comerciales:** no encontré un producto per-user de tracking continuo de flota con precio público claramente comparable; las páginas revisadas son de control horario/entregas.
8. **iOS PWA en segundo plano:** no hay doc de Apple/WebKit que lo afirme o desmienta explícitamente; la conclusión se apoya en la especificación W3C y en MDN (visibilidad), más resúmenes de Google no citados como fuente.
9. **Impuestos:** vigencia del 30 % (conflicto de fuentes), IVA 21 % y Ingresos Brutos sin fuente primaria; falta confirmar con el banco emisor y el contador.
10. **Dólar MEP:** solo agregador (dolarapi) y resumen de Ámbito vía Google; no abrí la página de Ámbito.
11. **BNA:** la cotización leída es del 5/11/2026 17:00; no había actualización del 6/11 al momento de la lectura (la nota de Ámbito/TN indica 1570 también el 6/11).
