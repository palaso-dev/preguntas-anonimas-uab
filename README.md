# Confesiones Anónimas — UAB

Aplicación web para recibir confesiones anónimas mediante código QR, moderarlas y mostrarlas en vivo.

## Enlaces en vivo (GitHub Pages + Supabase)

| Vista | URL |
| :--- | :--- |
| **Formulario QR (invitados)** | https://palaso-dev.github.io/preguntas-anonimas-uab/ |
| **Panel de control (moderación)** | https://palaso-dev.github.io/preguntas-anonimas-uab/admin.html |
| **Pantalla gigante / proyector** | https://palaso-dev.github.io/preguntas-anonimas-uab/live.html |
| **Presentadores** | https://palaso-dev.github.io/preguntas-anonimas-uab/presentadores.html |
| **Tarjeta QR imprimible** | https://palaso-dev.github.io/preguntas-anonimas-uab/qr.html |

*(La versión estática está en la carpeta `docs/`. El acceso a `admin.html` y `presentadores.html` usa el usuario creado en Supabase Authentication).*

---

## Modo local alternativo (SQLite + Cloudflare Tunnel)

## Cómo iniciar la noche de la gala (Recomendado)

```bash
npm run gala
```

Este comando hace todo automáticamente:
1. Levanta el servidor local y la base de datos SQLite en `data/confesiones.db`.
2. Evita que la Mac entre en reposo durante la gala (`caffeinate`).
3. Abre un túnel público HTTPS (`https://....trycloudflare.com`) para que cualquier invitado entre con su 4G/5G o Wi-Fi.
4. Actualiza automáticamente el código QR con la URL pública activa y muestra todos los enlaces en la terminal.

> **Importante:** Al usar un túnel rápido gratuito (`trycloudflare.com`), la URL pública cambia cada vez que reinicias `npm run gala`. Si vas a imprimir los QR de las mesas con anticipación, inicia `npm run gala` antes de imprimir/proyectar la tarjeta desde `/qr`, o deja esta Mac encendida hasta que termine el evento.

## Cómo iniciar solo en red local / Wi-Fi

Si todos estarán en la misma red Wi-Fi y no necesitas túnel a internet:

```bash
npm start
```

## Rutas disponibles

| Ruta | Uso | Acceso |
| :--- | :--- | :--- |
| `/` | Formulario móvil para que los invitados envíen confesiones | Público (el link del QR) |
| `/admin` | Panel de moderación, aprobación, proyección y ajustes | PIN inicial: **`2026`** |
| `/presentadores` | Lista filtrada en tiempo real para celular o tablet en escenario | PIN o link mágico desde `/admin` |
| `/live` | Pantalla gigante / proyector (QR, confesión destacada o muro) | Público (controlado desde `/admin` y `/presentadores`) |
| `/qr` | Tarjeta navideña imprimible / descargable en PNG o SVG | Público |

## Cambiar el PIN inicial

Puedes iniciar con un PIN personalizado usando la variable `ADMIN_PIN` la primera vez, o cambiarlo en cualquier momento desde **`/admin` → Ajustes**.

## Dónde se guardan los datos y cómo respaldarlos

- Todas las confesiones, estados (`pending`, `approved`, `read`, `rejected`) y ajustes se guardan localmente en `data/confesiones.db`.
- Si reinicias el servidor, los datos permanecen intactos.
- Desde **`/admin` → Ajustes**, puedes descargar todas las confesiones en **CSV (compatible con Excel)** o **JSON**.
