# Protocolo de prueba en teléfonos reales (issue #40)

Prototipo descartable: una PWA que solo guarda marcas falsas en IndexedDB y las envía. Sirve para comprobar en los
teléfonos de los Choferes, antes de que la app real dependa de eso, que el almacenamiento, la instalación y el envío
funcionan. Nada de este directorio entra en las apps reales. No se cargan datos reales: cada marca tiene solo un id,
la etiqueta del teléfono y la hora.

## Preparación

1. En la PC, desde la raíz del repo: `sh deploy/local-staging.sh up` (ver "Local staging" en `deploy/README.md`).
2. Tomá la URL `office:` que imprime y agregale `/offline-prototype/`. Por ejemplo
   `https://abc-def.trycloudflare.com/offline-prototype/`.
3. No reinicies el staging durante una sesión: la URL cambia con cada `up` y la app instalada queda apuntando a la
   anterior. Lo que el servidor del prototipo recibió se pierde al reiniciar el contenedor.
4. Anotá cada teléfono en la tabla. El primero tiene que ser el iPhone de un Chofer.

| # | Teléfono | Modelo y versión del sistema | Navegador | Del Chofer |
|---|---|---|---|---|
| 1 | iPhone de un Chofer | | Safari | |
| 2 | Android de un Chofer | | Chrome | |

En cada teléfono, abrí la URL, escribí una etiqueta en **Phone label** (por ejemplo `iPhone 1`) y tocá
**Save label**. La etiqueta separa las marcas de cada teléfono en el servidor.

La sección **This phone**, al pie de la página, muestra si la app se abrió desde la pantalla de inicio, si hay
conexión, si el almacenamiento es persistente, cuánto ocupa y si hay push. Sacale una captura al terminar cada prueba.

## 1. Instalación en la pantalla de inicio de iOS

1. En el iPhone, abrí la URL en Safari, tocá Compartir y elegí **Agregar a inicio**.
2. Abrí la app desde el ícono **Offline test**. Se tiene que abrir sin la barra de Safari.
3. **This phone** tiene que decir `Opened from the home screen: yes`. Volvé a guardar la etiqueta, porque la app
   instalada en iOS no comparte almacenamiento con Safari.
4. En Android, abrí la URL en Chrome y elegí **Instalar app** o **Agregar a pantalla principal**. Comprobá lo mismo.

Todas las pruebas que siguen se hacen desde la app instalada.

## 2. Pérdida de señal

1. Activá el modo avión.
2. Tocá **Add fake mark** tres veces. **pending** tiene que subir a 3, y **Last flush** tiene que mostrar un error
   de red.
3. Cerrá la app y volvé a abrirla, todavía en modo avión. Tiene que abrir igual y seguir mostrando 3 pendientes.
4. Desactivá el modo avión sin tocar nada. Al volver la conexión, **pending** tiene que bajar a 0 solo, sin tocar
   **Send now**. Si no baja, tocá **Send now** y anotá que el envío automático no funcionó.
5. En **Server**, **Received** tiene que mostrar 3 marcas.

## 3. Reenvío sin duplicados

1. Con señal, marcá **Drop the next acknowledgement** y tocá **Add fake mark**. El servidor guarda la marca, pero el
   teléfono hace de cuenta que no recibió la respuesta. La marca queda en **pending** y el casillero se desmarca.
2. Tocá **Send now**. **pending** tiene que bajar a 0.
3. Tocá **Refresh**. La marca tiene que aparecer una sola vez en **Server**, con `sent 2×`. **repeated sends stored
   once** tiene que haber subido en 1.
4. Repetí la prueba con señal real cortada a mitad del envío: tocá **Add fake mark** y activá el modo avión enseguida.
   Al desactivarlo, cada marca tiene que figurar una sola vez en el servidor.

## 4. App cerrada

1. En modo avión, agregá 2 marcas.
2. Cerrá la app del todo: deslizala fuera del selector de apps.
3. Desactivá el modo avión y esperá 2 minutos sin abrir la app.
4. Abrí la app y anotá lo que muestra **pending** apenas abre. Las marcas tienen que salir en cuanto abre. La
   prueba es si salieron con la app cerrada, algo que la app real no espera.
5. Tocá **Refresh**: cada marca tiene que aparecer una sola vez.

## 5. Teléfono reiniciado

1. En modo avión, agregá 2 marcas.
2. Apagá el teléfono y volvé a encenderlo. Si el modo avión se desactivó, volvé a activarlo antes de abrir la app.
3. Abrí la app desde el ícono, todavía en modo avión. Las 2 marcas tienen que seguir en **pending**.
4. Desactivá el modo avión. Las marcas tienen que salir solas, una sola vez cada una.

## 6. Push

En iOS esta prueba solo funciona desde la app instalada (paso 1) y con iOS 16.4 o posterior.

1. Tocá **Allow notifications and subscribe** y aceptá el permiso. Tiene que decir `Subscribed.`
2. Tocá **Send a push in 30 s** y cerrá la app del todo.
3. Dentro de unos 30 segundos tiene que llegar la notificación **Offline prototype**. Anotá cuánto tardó.
4. Repetí con el teléfono bloqueado y con el modo de bajo consumo activado.
5. Abrí la app y tocá **Refresh**. En **Push** tiene que figurar el código que respondió el servicio de push de Apple
   o Google. `201` significa que el servicio lo aceptó. Cualquier otro código va a los hallazgos con su texto.

## 7. Desalojo del almacenamiento en iOS

Safari puede borrar los datos de una web que no se usó en 7 días. Esta prueba comprueba si eso también pasa con la
cola de la app instalada.

1. En el iPhone, en modo avión, agregá 2 marcas y anotá la fecha y lo que dice `Persistent storage`.
2. No abras la app durante 8 días. El teléfono se puede usar normalmente.
3. El día 8, activá el modo avión y abrí la app desde el ícono. La app abre sin señal aunque el staging esté apagado.
   Anotá si las 2 marcas siguen en **pending**.
4. Si siguen, desactivá el modo avión con el staging levantado. Si la URL cambió, las marcas no llegan, porque la app
   apunta al túnel anterior, y eso no es una falla de almacenamiento.

## Registro de hallazgos

Copiá esta tabla al PR cuando termines, con una fila por prueba y teléfono.

| Prueba | Teléfono | Resultado | Notas |
|---|---|---|---|
| 1. Instalación | 1 | | |
| 2. Pérdida de señal | 1 | | |
| 3. Reenvío sin duplicados | 1 | | |
| 4. App cerrada | 1 | | |
| 5. Teléfono reiniciado | 1 | | |
| 6. Push | 1 | | |
| 7. Desalojo en iOS | 1 | | |
