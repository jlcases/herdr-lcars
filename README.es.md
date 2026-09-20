# LCARS for Herdr — Centro de mando de agentes de IA

![Panel principal de LCARS for Herdr con una flota de 200 agentes](docs/images/herdr-lcars-dashboard.png)

**Dirige hasta 2.000 agentes de IA desde un solo puente LCARS.**

**Versión v0.1.0** · **Español** · [English](README.md)

LCARS for Herdr es el centro de mando en vivo para [Herdr](https://herdr.dev): muestra quién trabaja
o está bloqueado, controla la cuota de Claude Code y Codex por cuenta y releva contexto verificado
entre motores sin perder ni duplicar trabajo.

Requisitos de ejecución: Herdr 0.9.0+ y Node 22+. El plugin v0.1.0 funciona en macOS y Linux;
todavía no soporta Windows.

Cuando un motor se queda sin cuota o deja de convenir, LCARS abre otro en el mismo checkout, le
entrega el contexto guardado y mantiene abierto el agente de origen hasta que la persona comprueba
el relevo.

> [!IMPORTANT]
> LCARS for Herdr es una interfaz no oficial hecha por fans y no está afiliada ni respaldada por
> Herdr, CBS Studios, Paramount ni por los titulares de las marcas y diseños de referencia. Véase
> [NOTICE.md](NOTICE.md).

## 1. Instala primero Herdr

LCARS for Herdr es un plugin, no un sustituto independiente de Herdr. Si todavía no tienes el
comando `herdr`, sigue la [guía oficial de instalación de Herdr](https://herdr.dev/docs/install/).
Las vías compatibles más directas son:

```sh
# macOS con Homebrew
brew install herdr

# o el instalador directo oficial en macOS / Linux
curl -fsSL https://herdr.dev/install.sh | sh
```

Comprueba ambos requisitos antes de continuar:

```sh
herdr --version  # debe ser 0.9.0 o posterior
node --version   # debe ser v22 o posterior
```

Arranca Herdr al menos una vez con `herdr`; LCARS solo habla con su socket local y no puede
funcionar sin él.

## 2. Instala LCARS for Herdr v0.1.0

Instala desde GitHub la versión estable:

```sh
herdr plugin install jlcases/herdr-lcars --ref v0.1.0 --yes
herdr plugin action invoke dev.jlcases.herdr-lcars.ping     # comprobación
herdr plugin action invoke dev.jlcases.herdr-lcars.open     # abre el panel
```

Durante el desarrollo, enlaza el directorio en vez de instalarlo:

```sh
herdr plugin link /ruta/a/herdr-lcars
herdr plugin unlink dev.jlcases.herdr-lcars
```

Herdr arranca el puente solo al iniciar la sesión (`[[startup]]`). Acciones disponibles:

| Acción | Qué hace |
|---|---|
| `open` | Arranca el puente si hace falta y abre el plano de la nave (MSD). |
| `open-deck` | Abre la cubierta compacta. |
| `restart` | Reinicia el proceso. Las pestañas abiertas se recargan solas. |
| `stop` | Detiene el puente. |
| `fuel` | Abre el cuadro de combustible por cuenta en una ventana modal. |
| `accounts` | Abre el catálogo local de perfiles de Claude/Codex. |
| `ping` | Diagnóstico por notificación: Node, puente, socket y cuentas detectadas. |

El cuadro de combustible también se puede abrir directamente como pane:

```sh
herdr plugin pane open --plugin dev.jlcases.herdr-lcars --entrypoint fuel
```

Atajos de teclado, en `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+shift+f"
type = "plugin_action"
command = "dev.jlcases.herdr-lcars.open"
description = "panel LCARS"

[[keys.command]]
key = "prefix+shift+g"
type = "plugin_action"
command = "dev.jlcases.herdr-lcars.fuel"
description = "combustible por cuenta"
```

### Configuración

`herdr plugin config-dir dev.jlcases.herdr-lcars` imprime el directorio donde vive `config.env`,
que se crea solo la primera vez:

```sh
LCARS_PORT=4700        # panel y receptor OTLP
LCARS_LOW_QUOTA=10     # % restante por debajo del cual avisa, por cuenta
# NODE_BIN=/opt/homebrew/bin/node   # solo si la detección de Node falla
```

El servidor de Herdr corre bajo launchd con `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, así que `node` no
está a su alcance. Por eso todos los comandos del manifiesto empiezan por `sh` y es `bin/plugin`
quien localiza Node (nvm, fnm, volta, asdf, Homebrew) y exige la versión 22 o superior. Si algo no
arranca: `herdr plugin log list --plugin dev.jlcases.herdr-lcars`, y el registro del propio puente
está en `bridge.log` dentro del directorio de estado del plugin.

### Compatibilidad de plataforma

| Sistema | Estado real | Límite |
|---|---|---|
| macOS | Soportado y probado con la flota real. | Claude se lee desde Keychain; el launcher contempla el `PATH` mínimo de launchd. |
| Linux | Soportado por manifiesto y validado en CI (Node, shell y tests). | Falta todavía una prueba de instalación completa contra un Herdr real en Linux. Claude usa el fichero privado oficial del perfil. |
| Windows | No soportado por este plugin todavía. | El núcleo Node es portable, pero el manifiesto llama a `sh` y los wrappers son POSIX. Herdr marca los plugins nativos de Windows como *preview*; no se declara `windows` hasta disponer de launcher, statusline y pruebas nativas. |

El manifiesto refleja esa verdad con `platforms = ["macos", "linux"]`. Ejecutar solo el servidor con
Node en Windows no equivale a tener el plugin integrado; añadir `windows` a mano no convierte los
scripts POSIX en lanzadores nativos.

### Varias cuentas de Claude o Codex

Sí: cada cuenta vive en su directorio oficial aislado y el relevo permite elegir tanto motor como
cuenta. Una sesión abierta nunca cambia de credencial a mitad de turno; LCARS abre otro pane con el
perfil elegido, entrega la memoria y mantiene el origen visible. También se puede hacer
Claude → Claude o Codex → Codex.

La acción `accounts` abre `accounts.json`, junto a `config.env`. El fichero no admite tokens ni
comandos, solo identificadores, etiquetas y rutas:

```json
{
  "version": 1,
  "profiles": [
    { "id": "claude-work", "provider": "claude", "label": "Claude trabajo", "home": "~/.claude-work" },
    { "id": "claude-personal", "provider": "claude", "label": "Claude personal", "home": "~/.claude-personal" },
    { "id": "codex-work", "provider": "codex", "label": "Codex trabajo", "home": "~/.codex-work" }
  ]
}
```

Autentica cada directorio localmente con el flujo oficial del CLI y reinicia el puente (o espera
como máximo un minuto a que relea el catálogo):

```sh
CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude       # después, /login
CODEX_HOME="$HOME/.codex-work" CODEX_SQLITE_HOME="$HOME/.codex-work" codex login
```

No copies `auth.json`, llaveros ni OAuth tokens entre máquinas. En otra máquina —también una máquina
remota guardada en Herdr— autentica allí sus perfiles y configura allí este plugin. LCARS pasa al
pane nuevo únicamente `CLAUDE_CONFIG_DIR` o `CODEX_HOME`/`CODEX_SQLITE_HOME`, además de un alias no
secreto para atribuir su cuota.

El cambio de cuenta es deliberadamente manual y confirmado: cuando un depósito se agota eliges el
otro en el panel de detalle. No hay rotación silenciosa de suscripciones ni se toca una sesión viva.

## Uso suelto, sin plugin

```sh
node bin/lcars-bridge.mjs --open          # http://127.0.0.1:4700
node bin/lcars-bridge.mjs --port 4700 --host 127.0.0.1 --socket ~/.config/herdr/herdr.sock
open "http://127.0.0.1:4700/?demo=200"    # flota sintética para ver la escala
```

## Dos vistas

- **MSD** (`/msd.html`): Master Systems Display al estilo de la lámina de la Enterprise-D, pensado para 32:9
  (Samsung G9, 5120×1440). La silueta está trazada a partir de las láminas publicadas de perfil lateral y planta de
  la patente de diseño estadounidense D307,923 (Andrew Probert, 1990). OpenCV (`tools/trace-ship.py`) regenera
  `public/ship.json` y las texturas de tinta. [NOTICE.md](NOTICE.md) distingue la expiración de la patente de los
  derechos de autor y marcas de terceros. La flota es la nave en sección: platillo, cuello y casco de
  ingeniería se rellenan por barrido de líneas dentro de cada polígono con un compartimento por agente, agrupados por workspace con su línea de llamada y etiqueta en el margen (agentes,
  trabajando, bloqueados, tok/min, coste). El deflector indica el enlace con Herdr, la góndola brilla según la salida
  de la flota y lleva dentro la sparkline de la última hora, el puente parpadea en alerta roja y los raíles del marco
  se ponen rojos si hay bloqueados. Debajo de la nave aparece primero la franja de cuadrados numerados —una luz por
  agente, conservada como identidad visual del producto— y después las lecturas numéricas. El área de operaciones
  reserva la columna principal completa al detalle del sistema: al elegir un workspace mantiene visibles todos sus
  agentes como fichas con nombre, y al elegir una ficha abre debajo su telemetría y salida. La otra columna queda
  para motores y cuota por cuenta, con solo una ventana compacta y desplazable de eventos recientes debajo.
  Doble clic en un compartimento salta al terminal. En pantallas con relación mayor que 2.3:1 la raíz
  redirige aquí sola (`?classic=1` evita la redirección).
- **Compacta** (`/index.html`): la cubierta de celdas para monitores 16:9 y portátil.

Ambas vistas comparten el mismo control de relevo, estados de carga/error, foco visible y navegación
por teclado. El selector `ES / EN` cambia también los textos dinámicos y conserva la elección entre
sesiones y entre vistas. La gama LCARS/MSD original se conserva; el texto secundario reutiliza tonos de esa misma
paleta con contraste AA. Antonio se sirve desde el propio plugin (OFL), sin petición a Google Fonts.

## Qué muestra la vista compacta

| Zona | Contenido |
|---|---|
| Barra izquierda | Filtros por estado con contadores (bloqueados, trabajando, terminados, en espera). |
| Indicadores | Agentes conectados, trabajo actual, salida media de los últimos 2 minutos (sparkline última hora), velocidad mediana, TTFT mediana, coste de las sesiones vivas y cuota restante 5 h / 7 d. |
| Cubierta | Una celda por agente agrupada por workspace. Color y pulso según estado; tok/s de la última petición, coste, tokens de salida, barra de contexto usado, mini-sparkline. Los workspaces con bloqueados suben arriba. |
| Alerta roja | Lista de bloqueados ordenada por antigüedad. Clic selecciona, doble clic salta al terminal. |
| Detalle | Velocidad, TTFT p50/p95, latencia, peticiones, tokens, caché, coste, contexto, herramientas, turnos, serie temporal y las últimas 40 líneas del terminal. Botón "Ir al terminal" enfoca el pane en Herdr. |
| Eventos recientes | Ventana compacta y desplazable de cambios de estado, prompts, turnos completados, errores de API, herramientas fallidas y rechazos. |

Botones: `SONIDO` (aviso breve al terminar y alarma más intensa al bloquearse), `SALA` (modo pantalla de sala
sin columna derecha). `Esc` deselecciona.
Con más de 60 agentes las celdas pasan a modo compacto; con más de 140, a modo denso.

## De dónde salen los datos

1. **Herdr** (`~/.config/herdr/herdr.sock`): `session.snapshot` cada segundo (topología, estado, título, cwd,
   id de sesión de Claude) más `events.subscribe` por pane para reaccionar al instante a los cambios de estado.
2. **OpenTelemetry de Claude Code**: el servidor es también un receptor OTLP http/json (`/v1/logs`, `/v1/metrics`).
   El evento `api_request` trae por petición `ttft_ms`, `duration_ms`, tokens (input, output, caché lectura/escritura),
   `cost_usd`, modelo, `stop_reason` y `query_source`. Configurado en `~/.claude/settings.json` (`env`):

   ```json
   "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
   "OTEL_LOGS_EXPORTER": "otlp",
   "OTEL_METRICS_EXPORTER": "otlp",
   "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
   "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4700",
   "OTEL_LOGS_EXPORT_INTERVAL": "2000"
   ```
   Solo lo exportan las sesiones arrancadas después de este cambio.
3. **Uso directo de Claude**: una consulta acotada cada minuto al endpoint fijo que utiliza Claude Code aporta las ventanas
   5 h / 7 d aunque no haya una sesión activa. En macOS toma el token del servicio de Keychain que usa Claude Code;
   en Linux, de `.credentials.json` dentro del home aislado del perfil, que debe ser privado. El token solo existe en
   memoria durante la petición, no se registra, persiste ni entrega al navegador. Anthropic no documenta ese endpoint
   como API pública estable, por eso cualquier fallo degrada al statusline y al caché en vez de tumbar el puente.
4. **Statusline de Claude Code**: `bin/lcars-statusline` envuelve el comando de statusline existente y deja el JSON
   de cada sesión en `~/.cache/lcars-bridge/status/<session>.json`. De ahí salen contexto usado (%), coste acumulado
   según Claude Code y estado de la caché de prompt. Su cuota es un respaldo por sesión, no la autoridad principal.
5. **Transcript JSONL** (`~/.claude/projects/*/<session>.jsonl`): fallback para sesiones sin OTEL. Da tokens, coste
   estimado, modelo, turnos y herramientas, pero **no TTFT** (se muestra `–`, nunca un cero fingido). Formato interno
   de Claude Code, no documentado: el parser es defensivo y se desactiva en cuanto la sesión exporta OTEL.

## Otros CLIs (adaptadores)

Herdr indica el tipo de agente de cada pane y, para los CLIs con integración instalada, el id de sesión. Con eso el
servidor activa un adaptador por tipo (`server/adapters/`):

| CLI | Fuente | Qué aporta |
|---|---|---|
| Codex | Rollouts JSONL en `~/.codex/sessions/AAAA/MM/DD/rollout-*-<session>.jsonl` (si Herdr no reporta la sesión, se empareja por directorio de trabajo) | Tokens por respuesta (entrada, caché, salida, razonamiento), modelo y esfuerzo, duración y TTFT reales por turno (`task_complete`), ventana de contexto usada, límites de cuota, herramientas y errores |
| OpenCode | SQLite `~/.local/share/opencode/opencode.db` leída con `sqlite3` | Coste real, tokens (entrada, salida, razonamiento, caché), modelo y proveedor, duración por respuesta, sesiones hijas como subagentes, herramientas, errores de API |

Precios de modelos no Anthropic en `server/pricing-extra.json` (tabla derivada de CASIA). Pendientes: Kimi, pi,
Gemini/Qwen, Grok, Hermes.

## Definiciones

- **tok/s** = `output_tokens / (duration_ms − ttft_ms)`: velocidad de decodificación, sin contar el tiempo hasta el
  primer token. Sin TTFT (transcript) se usa la duración completa y sale un valor más bajo. Se excluyen peticiones
  auxiliares (título de sesión, compactación) del cálculo de velocidad y TTFT.
- **Coste**: `cost_usd` de OTEL cuando existe; si no, tarifa API por modelo (`server/pricing.mjs`) con caché de
  lectura al 10 % del input (Fable 5.1: 0,25 $/M) y escritura 5 m/1 h al 125 %/200 %. El detalle prefiere el coste
  acumulado que reporta el statusline de Claude Code.
- **Cuotas**: una por CUENTA, no global. Cada credencial es un depósito con sus propias ventanas de
  5 h y 7 d cuando el proveedor las publica.
  La identidad sale de `~/.claude.json` (`oauthAccount`) y de `~/.codex/auth.json`; el valor de Claude
  sale primero del endpoint de uso de Claude Code y el de Codex de sus rollouts. El statusline queda como respaldo.
  El `cachedUsageUtilization` de
  `~/.claude.json` solo se usa como respaldo frío y se marca como tal: se ha medido con más de 48 horas
  de antigüedad. Las dos filas conservan su sitio: una ventana ausente o ya reiniciada dice **sin
  señal**, nunca «depósito lleno». Una ventana omitida durante un tick solo se conserva si pertenece
  a la misma cuenta y aún no ha vencido. Dentro de una misma ventana el consumo solo puede subir; al
  cambiar el instante de reposición puede bajar. Así un snapshot tardío nunca convierte el 43 %
  restante en un 54 % falso. La interfaz muestra siempre **porcentaje restante**, tanto en el número
  como en la barra.
- **Tiempo real**: cada lectura de Claude, statusline o rollout genera un evento `accounts` inmediato
  por el mismo SSE del panel. No espera al tick general ni abre un WebSocket innecesario. La fuente
  fuente directa de Claude se sondea cada minuto; «en tiempo real» describe la entrega al panel, no una
  conexión permanente con Anthropic.
- **Ritmo**: cuántos puntos se desvía el gasto del reloj de la ventana. `↑30` es quemar por delante.
  Se calla en el primer 5 % de la ventana, donde la proporción es ruido, y con desvíos de menos de 5 puntos.
- **Aviso de cuota baja**: notificación nativa de Herdr al bajar del umbral (`LCARS_LOW_QUOTA`, 10 % por
  defecto), una sola vez por cuenta y rearmada al volver por encima.

## Memoria de contexto y relevo de motor

Un agente no es un CLI: es una carpeta con trabajo a medias en una rama. El CLI es el motor, y se
puede cambiar. Lo que persiste entre motores es el **registro del contexto**, identificado por
`(repositorio, rama, checkout)` y guardado fuera del repositorio.

El registro se escribe en dos capas, y la separación es deliberada:

- **Mecánica, la escribe el puente.** Los ficheros tocados salen de `git`, no de las llamadas a
  herramientas del motor. Esa es la decisión de fondo: git ve lo que cambian los ocho motores,
  incluidos los seis cuyo transcript no sé leer. La memoria deja de depender del formato de cada CLI.
- **Narrativa, la escribe el motor si sabe.** Objetivo, decisiones y siguiente paso, por
  `POST /api/remember`. Es opcional: el motor al que te pasas cuando se acaba la cuota suele ser el
  más flojo, así que la memoria no puede depender de que mantenga un diario con disciplina.

El registro no se edita directamente: cada cambio se expresa como un evento validado y se pliega en
un **snapshot versionado**. No se presenta como un event store ni promete reconstrucción histórica
que el disco no conserva. Cuando el motor de origen sí tiene lector nativo
(hoy Claude y Codex), su hilo enriquece el registro en vez de sustituirlo, y releerlo no duplica
turnos.

La fotografía de git usa `status --porcelain=v2 -z`: conserva rutas con espacios, renombres y el
primer carácter del nombre; un sondeo idéntico no suma un falso “cambio”. Cada contexto se identifica
con repositorio, rama **y checkout completos**, y su clave de disco es SHA-256. Los snapshots se
escriben con bloqueo por contexto, temporal único, `fsync`, reemplazo atómico y permisos `0700/0600`.
Al migrar la versión antigua se conserva la narrativa y se descarta la mecánica que no era fiable;
una clave antigua ambigua nunca se comparte entre worktrees.

El relevo, entonces:

1. Redacta el resumen desde el registro, no desde el transcript. Si no hay memoria de ese contexto,
   no se abre nada.
2. Valida que el motor esté instalado, registra el intento y abre un pane nuevo en el mismo directorio.
   Arranca ahí el motor entrante, esperando a que el
   shell exista y a que el agente quede listo para recibir entrada: registrado no es lo mismo que
   disponible.
3. Le entrega objetivo, siguiente paso, ficheros reales, decisiones, intentos fallidos, el hilo
   reciente y lo que NO viaja (permisos, servidores MCP, herramientas en vuelo, subagentes), con la
   orden de responder solo con su estado y detenerse.
4. Marca el relevo como entregado o fallido. La genealogía solo avanza cuando la entrega se confirmó;
   ver dos motores sondeando el mismo checkout no inventa un relevo.

El pane de origen no se cierra ni se toca nunca. Si el motor entrante no arranca, su pane se cierra
y no queda nada suelto. Si el transporte falla durante la entrega, el pane nuevo queda visible porque
el resultado es ambiguo. La interfaz exige confirmación explícita y usa `request_id`, de modo que un
doble clic o reintento de red no abre dos motores.

### Arquitectura

Hexagonal, en `server/context/`. El dominio y los casos de uso no importan `node:fs`, ni git, ni el
socket de Herdr: reciben puertos ya construidos. Por eso el traspaso entero se ejercita con dobles
en memoria, sin esperas reales.

```
domain/          puro: identidad, vocabulario de eventos, el registro como pliegue, el resumen
ports.mjs        contratos; un adaptador incompleto falla al componer, no en producción
usecases/        ingesta mecánica, memoria narrativa, lectura y relevo
adapters/        git, repositorio de snapshots, catálogo de motores, Herdr, lectores de hilo, reloj
registry.mjs     lectores por motor; añadir uno no toca el dominio
scheduler.mjs    cuándo observar (el caso de uso decide qué)
composition.mjs  el único módulo que conoce adaptadores concretos
```

### Rendimiento y límites

- Cada contexto caliente ejecuta un único `git status` por observación; `git log` solo se consulta si
  cambia HEAD. La cadencia normal es 30 s y el scheduler tiene un pool de seis workers, no un
  `Promise.all` de hasta 200 procesos.
- Los lectores de relevo de Claude/Codex procesan como máximo los últimos 8 MiB de JSONL. El lector
  en vivo consume lotes de hasta 16 MiB, rechaza filas de más de 8 MiB y mantiene colas acotadas.
  Registro, ficheros, decisiones, fallos, turnos, agentes y relevos tienen límites propios.
- SSE comparte cada serialización entre clientes, limita conexiones y deja de escribir a un cliente
  mientras aplica backpressure. Los repintados del navegador se agrupan con `requestAnimationFrame`.
- Los polls sin cambios no reescriben el snapshot. Las escrituras de contextos distintos pueden
  avanzar en paralelo; las del mismo contexto se serializan también entre procesos.

## Seguridad

El servidor sirve el contenido de los terminales, así que se ciñe a la máquina local:

- Solo acepta bind en `127.0.0.1`, `localhost` o `::1`. Además, **cada** petición debe llevar un
  `Host` loopback; si trae `Origin`, este también debe ser HTTP loopback en el mismo puerto. Esto
  bloquea tanto CORS como DNS rebinding. No se emite `Access-Control-Allow-Origin`.
- Todos los controles exigen `application/json`, se limitan a 64 KiB y solo pueden operar sobre panes
  o directorios que Herdr reporta como activos. Los destinos de relevo salen del catálogo instalado,
  no del cuerpo HTTP.
- El navegador solo manda un id de perfil. Las rutas y las únicas variables de entorno permitidas se
  resuelven en el catálogo local validado; `accounts.json` tiene modo `0600` y no acepta secretos ni
  comandos. Una lectura anónima no se atribuye cuando hay dos cuentas posibles.
- El lector de cuota de Claude usa una URL HTTPS constante, rechaza redirecciones, limita timeout y
  respuesta y nunca incluye cuerpo remoto, stderr o token en los logs. En POSIX rechaza un fichero de
  credenciales legible por grupo u otros.
- Los dos frontales escapan todo lo que viene de fuera antes de insertarlo en el DOM: títulos de
  terminal (los fija cualquier proceso con una secuencia de escape), rutas, etiquetas de workspace,
  nombres de herramienta, descripciones de subagente y mensajes de error.
- El parámetro `lines` de `/api/read` se acota entre 1 y 2000. OTLP conserva un límite separado de
  16 MB comprimidos y 64 MB descomprimidos; codificaciones desconocidas se rechazan.
- CSP, `frame-ancestors 'none'`, COOP/CORP, `nosniff`, política de permisos y ausencia de JavaScript
  inline reducen la superficie del navegador. La tipografía se autoaloja.
- La memoria y los status drops son privados (`0700/0600`). El launcher no ejecuta `config.env`,
  verifica que un PID siga perteneciendo al puente antes de matarlo y rota el log a 5 MiB.
- Transcripts y narrativa se acotan, se deduplican con claves estables y redactan formatos comunes
  de credenciales antes de persistir o viajar. El resumen encierra la memoria en un bloque no fiable
  y neutraliza sus delimitadores.
- La telemetría que se envía al navegador no incluye los atributos OTLP crudos, que llevan
  identificadores de cuenta y correo.

## Pruebas

```sh
npm run check
npm run check:shell
npm test
```

Las de `tests/http.test.mjs` levantan el servidor en un puerto libre sin Herdr y comprueban el rechazo
cross-origin, el 415 de `/api/focus`, la acotación de `lines`, la bomba gzip y que OTLP siga entrando.

Las de `tests/context/` ejercitan el dominio y los casos de uso con dobles, y también los adaptadores
reales con repositorios git y directorios temporales: exactitud de porcelain v2, migración, permisos,
corrupción y 20 escrituras concurrentes. Hay pruebas específicas de seguridad HTTP, launcher,
statusline, contraste y markup. CI repite checks, tests y `npm pack --dry-run` en Node 22, 24 y 26.

Entre los casos de aceptación:

- el relevo funciona **desde un motor cuyo hilo no sé leer**, que es el motivo de todo esto;
- si el motor entrante no arranca, su pane se cierra y no queda nada suelto;
- si la entrega falla, se informa y el pane nuevo se deja abierto para mirarlo, pero la genealogía no
  avanza hasta que haya entrega confirmada;
- un doble clic es idempotente y 30 contextos nunca exceden la concurrencia configurada.

## Estructura

```
herdr-plugin.toml         manifiesto del plugin de Herdr (arranque, acciones, panel emergente)
bin/plugin                entrada del plugin: localiza Node, arranca/para el puente, diagnóstico
bin/lcars-bridge.mjs      CLI y arranque
bin/lcars-statusline      wrapper del statusline (deja un JSON por sesión)
server/index.mjs          HTTP estático + SSE (/events) + OTLP + /api/focus, /api/read, /api/session
server/telemetry.mjs      almacén por sesión: rangos de fuente, totales, percentiles, series por minuto
server/herdr.mjs          cliente del socket de Herdr (snapshot, suscripciones, focus, read)
server/claude.mjs         formato en disco de Claude Code: rutas, índice de proyectos, filas de transcript
server/jsonl.mjs          seguimiento incremental de JSONL (la última línea a medias, en un solo sitio)
server/transcripts.mjs    respaldo por transcript cuando la sesión no exporta OTLP
server/subagents.mjs      subagentes de cada sesión
server/statusdrop.mjs     lector de los volcados del statusline
server/adapters/          CLIs (codex, opencode) y cuota oficial de Claude; composición en server/index.mjs
server/pricing.mjs        tarifas por modelo (+ pricing-extra.json para los que no son de Anthropic)
server/limits.mjs         cuotas desde tmux-agent-indicator
server/accounts.mjs       un depósito por cuenta: identidad, ventanas, ritmo y aviso de cuota baja
server/account-profiles.mjs catálogo no secreto y entorno de lanzamiento por perfil
server/context/           memoria de contexto y relevo de motor (hexagonal, ver más arriba)
public/shared.js          formato, panel de detalle, registro y capa de datos, común a las dos vistas
public/context.css        control de relevo, foco y estados compartidos; paleta inyectada por cada vista
public/app.js             vista compacta (cubierta de celdas)
public/msd.js             vista de nave (geometría y trazado)
tools/trace-ship.py       regenera la silueta desde las láminas de la patente
tools/fuel.mjs            cuadro de combustible por cuenta para el panel emergente de Herdr
tests/                    node --test
```

Añadir un CLI nuevo son dos pasos: un fichero en `server/adapters/` con `static kind` y un `sync(agents)`
que devuelva `paneId → sessionId`, y una entrada en la lista `ADAPTERS` de `server/index.mjs`. Si su
fidelidad difiere de la de OTLP, se declara en la tabla `SOURCES` de `server/telemetry.mjs`.

## API

- `GET /api/state` estado completo · `GET /events` SSE (`state`, `tick`, `accounts`, `event`)
- `GET /api/session?id=<session>` detalle con las últimas 60 peticiones
- `GET /api/read?pane_id=w1:p1&lines=40` salida reciente del terminal
- `POST /api/focus {"pane_id":"w1:p1"}` enfoca el pane en Herdr
- `GET /api/context?pane_id=w1:p1` contexto, memoria, cobertura y genealogía de motores
- `POST /api/remember {"pane_id":"w1:p1","goal":"…","nextStep":"…","decision":"…","requires":[{"kind":"mcp","name":"…"}]}` memoria narrativa
- `POST /api/handoff {"pane_id":"w1:p1","to_kind":"codex","account_profile":"codex-work","request_id":"<uuid>"}` relevo idempotente conservando la memoria del contexto
- `POST /v1/logs`, `/v1/metrics`, `/v1/traces` receptor OTLP http/json

### Referencias de diseño

La integración es propia y no depende de estos proyectos, pero contrasta sus invariantes con
[`herdr-agent-quota`](https://github.com/levi-qiao/herdr-agent-quota) (ventanas y frescura),
[`claude-code-account-switcher`](https://github.com/claude-code-tools/claude-code-account-switcher)
(aislamiento mediante `CLAUDE_CONFIG_DIR`) y
[`codex-account-switcher`](https://github.com/Cloud370/codex-account-switcher)
(hogares de ejecución aislados). LCARS no copia su manejo de tokens: los secretos permanecen bajo
los mecanismos de autenticación de cada CLI.
