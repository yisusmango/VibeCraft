// ═══════════════════════════════════════════════════════════════
//  server.js  —  Servidor Multijugador de VibeCraft
//  ─────────────────────────────────────────────────────────────
//  Stack: Express 4 + Socket.io 4
//
//  Arranque:
//    npm install express socket.io
//    node server.js
//
//  Protocolo de eventos Socket.io:
//  ┌──────────────────────┬─────────────────────────────────────────────────────┐
//  │ Evento               │ Payload                                             │
//  ├──────────────────────┼─────────────────────────────────────────────────────┤
//  │ playerUpdate         │ { id, pos:{x,y,z}, rot:{x,y} }                      │
//  │                      │  Client → Server → broadcast a todos los demás      │
//  ├──────────────────────┼─────────────────────────────────────────────────────┤
//  │ blockUpdate          │ { action:'add'|'remove', x,y,z, type, normal }      │
//  │                      │  Client → Server → broadcast a todos los demás      │
//  ├──────────────────────┼─────────────────────────────────────────────────────┤
//  │ updateProfile        │ { skin, username }                                  │
//  │                      │  Client → Server: guarda perfil en playerState      │
//  ├──────────────────────┼─────────────────────────────────────────────────────┤
//  │ playerProfileUpdated │ { id, skin, username }                              │
//  │                      │  Server → todos los demás, tras updateProfile       │
//  ├──────────────────────┼─────────────────────────────────────────────────────┤
//  │ playerLeft           │ { id }                                              │
//  │                      │  Server → todos, cuando un cliente se desconecta    │
//  ├──────────────────────┼─────────────────────────────────────────────────────┤
//  │ chatMessage          │ string (client→server) / { username, message }      │
//  │                      │  Client → Server → io.emit a todos (incluso emisor) │
//  ├──────────────────────┼─────────────────────────────────────────────────────┤
//  │ timeUpdate           │ { dayT: number }                                    │
//  │                      │  Server → todos (broadcast de corrección, 10 s)     │
//  │                      │  También emitido inmediatamente tras adminTimeUpdate │
//  ├──────────────────────┼─────────────────────────────────────────────────────┤
//  │ adminTimeUpdate      │ { dayT: number }                                    │
//  │                      │  Client → Server: un cliente establece la hora.     │
//  │                      │  El servidor actualiza globalDayT y hace io.emit    │
//  │                      │  ('timeUpdate') inmediato a TODOS los clientes      │
//  │                      │  (incluyendo al emisor) para sincronización instant.│
//  └──────────────────────┴─────────────────────────────────────────────────────┘
//
//  DECISIONES DE DISEÑO:
//  • Sin authoritative server: el servidor es un relay puro. Cada cliente
//    corre su propia física → latencia cero local, consistencia eventual.
//    Apropiado para un prototipo de sandbox cooperativo.
//  • El estado del mundo (blockMap) NO se guarda en el servidor. Los bloques
//    se sincronizan como eventos delta en tiempo real. La persistencia sigue
//    siendo IndexedDB en el cliente host (quien creó/cargó el mundo).
//  • socket.broadcast.emit() excluye al emisor → el cliente que generó el
//    evento no lo procesa dos veces.
//  • Las skins se almacenan en playerState como Data URL (Base64 PNG).
//    Se incluyen en worldInit para que jugadores que entren tarde reciban
//    las skins de los que ya están conectados.
//
//  CICLO DE DÍA/NOCHE PERSISTENTE:
//  • globalDayT avanza en el servidor mediante un setInterval de 100 ms.
//    El incremento se calcula con el tiempo real transcurrido desde el
//    último tick (delta real), no con el intervalo nominal, para ser
//    inmune al drift del event loop de Node.js.
//  • El valor actual se envía a cada cliente en worldInit para que
//    arranquen sincronizados desde el primer frame.
//  • Cada 10 segundos se hace broadcast de timeUpdate a todos los clientes
//    para corregir desincronizaciones acumuladas por lag de red.
//    Los clientes usan un dead-band de 0.05 y solo hacen snap si la
//    diferencia es mayor — si ya están sincronizados, ignoran el paquete
//    y el reloj local sigue avanzando fluido.
//  • adminTimeUpdate permite que un cliente (Dev Tools / atajos U/I/O/P)
//    establezca la hora autoritativamente. El servidor actualiza globalDayT
//    y emite timeUpdate inmediato a todos para sincronización instantánea.
// ═══════════════════════════════════════════════════════════════

import express    from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';

const app    = express();
const http   = createServer(app);
const io     = new SocketIO(http, {
  cors: {
    // En desarrollo permitimos cualquier origen. En producción
    // restringe esto a tu dominio: origin: 'https://tudominio.com'
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT ?? 3000;

// ── Servir los archivos estáticos del cliente ────────────────────
//  Express sirve la raíz del proyecto (donde está index.html).
//  Esto elimina la necesidad de un servidor separado (python -m http.server).
app.use(express.static('.'));

// ── Estado en memoria: mapa de jugadores conectados ──────────────
//  playerState: Map<socketId, { id, pos, rot, skin, username, lastSeen }>
//  • pos / rot   — para el snapshot inicial de posición.
//  • skin        — Data URL Base64 PNG, o null si el jugador no tiene skin.
//  • username    — string 1-16 chars [a-zA-Z0-9_], o null hasta recibirlo.
//  • lastSeen    — timestamp del último playerUpdate recibido.
const SERVER_SEED  = Math.random();
const playerState  = new Map();

// ═══════════════════════════════════════════════════════════════
//  ⏱️  CICLO DE DÍA/NOCHE PERSISTENTE EN EL SERVIDOR
//  ─────────────────────────────────────────────────────────────
//  globalDayT: número en [0, 1) que representa el progreso del ciclo.
//    0.0 = amanecer  /  0.25 = mediodía  /  0.5 = atardecer  /  0.75 = noche
//
//  DAY_DURATION: duración de un ciclo completo en segundos reales.
//    Debe coincidir con el valor DAY_DURATION de environment.js (1200 s).
//
//  TICK_INTERVAL: resolución del temporizador de servidor en ms.
//    100 ms = 10 Hz → resolución suficiente para un ciclo de 20 min.
//    Reducir a 50 ms si se necesita mayor precisión (más CPU).
//
//  CÁLCULO DEL INCREMENTO — delta real (anti-drift):
//    El event loop de Node.js puede retrasar setInterval varios ms.
//    Si usáramos un incremento fijo (TICK_INTERVAL / 1000 / DAY_DURATION)
//    el reloj se desaceleraría progresivamente bajo carga.
//    En cambio calculamos dt = (now - lastTick) / 1000 en cada tick,
//    garantizando que globalDayT avance en proporción al tiempo de pared
//    independientemente del jitter del temporizador.
//
//  CORRECCIÓN PERIÓDICA — timeUpdate broadcast (10 s):
//    Los clientes usan un dead-band de 0.05 al recibir timeUpdate:
//    solo hacen snap si la diferencia es mayor. Para correcciones pequeñas
//    (< 1 min de ciclo) el reloj cliente sigue avanzando local y fluido.
// ═══════════════════════════════════════════════════════════════

const DAY_DURATION   = 1200;    // segundos por ciclo completo (20 min)
const TICK_INTERVAL  = 100;     // ms entre ticks del reloj servidor
const SYNC_INTERVAL  = 10_000;  // ms entre broadcasts de corrección

let globalDayT   = 0.0;         // estado canónico del reloj [0, 1)
let _lastTickMs  = Date.now();  // timestamp del último tick (ms de pared)
let _syncTimer   = 0;           // acumulador para el broadcast de corrección (ms)

// ── Tick del reloj ────────────────────────────────────────────────
//  Se usa Date.now() para el delta real. El módulo %1.0 garantiza que
//  globalDayT siempre esté en [0, 1) incluso tras muchas horas de uptime.
setInterval(() => {
  const now = Date.now();
  const dtMs = now - _lastTickMs;     // ms reales transcurridos (puede > 100 ms)
  _lastTickMs = now;

  const dtSec = dtMs / 1000;         // convertir a segundos
  globalDayT  = (globalDayT + dtSec / DAY_DURATION) % 1.0;

  // ── Broadcast de corrección periódica ─────────────────────────
  //  Acumulamos el tiempo transcurrido en _syncTimer y emitimos
  //  cuando supera SYNC_INTERVAL. Esto es más robusto que un segundo
  //  setInterval porque comparte el mismo thread y no genera deriva
  //  de fase entre ambos timers.
  _syncTimer += dtMs;
  if (_syncTimer >= SYNC_INTERVAL) {
    _syncTimer -= SYNC_INTERVAL;
    io.emit('timeUpdate', { dayT: globalDayT });
    // Solo loguear si hay jugadores conectados para no saturar la consola
    if (io.engine.clientsCount > 0) {
      console.info(`[VibeCraft] timeUpdate broadcast: dayT=${globalDayT.toFixed(4)}`);
    }
  }
}, TICK_INTERVAL);

// ═══════════════════════════════════════════════════════════════
//  🔌  GESTIÓN DE CONEXIONES
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[VibeCraft] Jugador conectado: ${socket.id}  (total: ${io.engine.clientsCount})`);

  // Inicializar entrada con skin y username null hasta que el cliente los envíe
  playerState.set(socket.id, {
    id:       socket.id,
    pos:      { x: 0, y: 0, z: 0 },
    rot:      { x: 0, y: 0 },
    skin:     null,
    username: null,
    lastSeen: Date.now(),
  });

  // ── Snapshot inicial ───────────────────────────────────────────
  //  Enviar al recién llegado:
  //   • seed    — semilla de Simplex Noise para generación de terreno.
  //   • dayT    — progreso actual del ciclo de día/noche [0, 1).
  //               El cliente usará este valor para inicializar su
  //               Environment y arrancar sincronizado con el servidor.
  //   • players — estado completo de todos los jugadores ya conectados,
  //               incluyendo su propiedad `skin` (puede ser null).
  //  El recién llegado puede así renderizar skins ya aplicadas sin
  //  esperar a un evento playerSkinUpdated posterior.
  socket.emit('worldInit', {
    seed:    SERVER_SEED,
    dayT:    globalDayT,
    players: Array.from(playerState.values()),
  });

  // ── playerUpdate ───────────────────────────────────────────────
  //  Payload: { id, pos: {x,y,z}, rot: {x,y} }
  //  Actualiza pos/rot preservando la skin que ya estuviera guardada.
  socket.on('playerUpdate', (data) => {
    if (
      typeof data?.id  !== 'string'   ||
      typeof data?.pos !== 'object'   ||
      typeof data?.rot !== 'object'
    ) return;

    const existing = playerState.get(socket.id);
    playerState.set(socket.id, {
      ...existing,           // preserva skin y otros campos
      ...data,               // actualiza id, pos, rot
      lastSeen: Date.now(),
    });
    socket.broadcast.emit('playerUpdate', data);
  });

  // ── updateProfile ──────────────────────────────────────────────
  //  Payload: { skin, username }
  //    skin     — Data URL Base64 PNG completa (data:image/png;base64,…) o null
  //    username — string de 1-16 chars alfanuméricos/guión bajo, o null
  //  Validaciones:
  //    • skin debe empezar con el prefijo PNG y no superar 2 MB (si presente)
  //    • username debe ser string de 1-16 chars (si presente)
  //  Si algún campo no pasa la validación se ignora el mensaje completo.
  socket.on('updateProfile', ({ skin, username } = {}) => {
    // Validar skin si viene
    if (skin !== null && skin !== undefined) {
      if (
        typeof skin !== 'string'                   ||
        !skin.startsWith('data:image/png;base64,') ||
        skin.length > 2 * 1024 * 1024
      ) {
        console.warn(`[VibeCraft] updateProfile: skin inválida de ${socket.id} — ignorada.`);
        return;
      }
    }

    // Validar username si viene
    if (username !== null && username !== undefined) {
      if (
        typeof username !== 'string'     ||
        username.length < 1              ||
        username.length > 16             ||
        !/^[a-zA-Z0-9_]+$/.test(username)
      ) {
        console.warn(`[VibeCraft] updateProfile: username inválido de ${socket.id} — ignorado.`);
        return;
      }
    }

    // Actualizar playerState preservando los campos no enviados
    const existing = playerState.get(socket.id);
    if (existing) {
      if (skin     !== null && skin     !== undefined) existing.skin     = skin;
      if (username !== null && username !== undefined) existing.username = username;
      playerState.set(socket.id, existing);
    }

    console.info(
      `[VibeCraft] Perfil actualizado para ${socket.id}` +
      (username ? ` — username: ${username}` : '') +
      (skin     ? ` — skin: ${(skin.length / 1024).toFixed(1)} KB` : ''),
    );

    // Notificar a todos los demás para que actualicen modelo y name tag
    socket.broadcast.emit('playerProfileUpdated', {
      id: socket.id,
      skin:     skin     ?? null,
      username: username ?? null,
    });
  });

  // ── blockUpdate ────────────────────────────────────────────────
  //  Payload: { action:'add'|'remove', x,y,z, type, normal }
  //  Retransmite el delta a todos los demás sin procesarlo.
  socket.on('blockUpdate', (data) => {
    if (
      (data?.action !== 'add' && data?.action !== 'remove') ||
      typeof data?.x !== 'number' ||
      typeof data?.y !== 'number' ||
      typeof data?.z !== 'number'
    ) return;

    socket.broadcast.emit('blockUpdate', data);
  });

  // ── playerAction (punch, etc.) ──────────────────────────────────
  socket.on('playerAction', (data) => {
    if (typeof data?.action !== 'string') return;
    socket.broadcast.emit('playerAction', { id: socket.id, ...data });
  });

  // ── adminTimeUpdate — cambio de hora iniciado por un cliente ───
  //  Payload: { dayT: number }
  //
  //  Flujo:
  //    1. El jugador pulsa un botón de Dev Tools (U/I/O/P) mientras está
  //       en modo multijugador. main.js llama sendAdminTimeUpdate(dayT).
  //    2. El servidor recibe el payload, valida el rango y actualiza
  //       globalDayT para que el setInterval siga desde ahí.
  //    3. io.emit('timeUpdate', ...) notifica INMEDIATAMENTE a TODOS los
  //       clientes conectados (incluyendo al emisor) con el nuevo dayT.
  //    4. Cada cliente aplica el snap (o no, según su dead-band) en el
  //       handler timeUpdate de multiplayer.js.
  //
  //  Seguridad: se valida que dayT sea un número finito en [0, 1).
  //  No hay autenticación de "admin" real — en un juego cooperativo de
  //  prototipo cualquier jugador puede cambiar la hora, igual que en un
  //  servidor de Minecraft en modo cooperativo.
  socket.on('adminTimeUpdate', (data) => {
    if (typeof data?.dayT !== 'number' || !isFinite(data.dayT)) return;

    // Normalizar al rango [0, 1)
    globalDayT = ((data.dayT % 1.0) + 1.0) % 1.0;

    // Emitir timeUpdate inmediato a TODOS (io.emit, no broadcast)
    // para que el propio emisor también confirme el cambio y para que
    // todos los demás clientes salten al nuevo tiempo sin esperar 10 s.
    io.emit('timeUpdate', { dayT: globalDayT });

    const player   = playerState.get(socket.id);
    const username = player?.username ?? socket.id;
    console.info(`[VibeCraft] adminTimeUpdate de ${username}: dayT=${globalDayT.toFixed(4)}`);
  });

  // ── Chat Multijugador ─────────────────────────────────────────
  //  El username se extrae de playerState (fuente de verdad del servidor)
  //  para evitar spoofing: el cliente solo envía el texto del mensaje.
  //  Se retransmite a TODOS los clientes (io.emit, no broadcast) para
  //  que el emisor también vea su propio mensaje en el panel de chat.
  socket.on('chatMessage', (msg) => {
    // Validación básica: ignorar mensajes vacíos o que no sean texto
    if (typeof msg !== 'string' || msg.trim().length === 0) return;

    // Limitar a 64 caracteres (coincide con el maxlength del HTML)
    const cleanMsg = msg.trim().substring(0, 64);

    // Extraer el username de la fuente de la verdad (el servidor), previene spoofing.
    // playerState es un Map → usar .get(), no indexación directa.
    const player   = playerState.get(socket.id);
    const username = (player?.username) ? player.username : 'Player';

    console.info(`[VibeCraft] Chat de ${username}: ${cleanMsg}`);

    // Retransmitir a TODOS los clientes conectados (incluyendo al emisor)
    io.emit('chatMessage', { username, message: cleanMsg });
  });

  // ── Desconexión ────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    console.log(`[VibeCraft] Jugador desconectado: ${socket.id} (${reason})`);
    playerState.delete(socket.id);
    // Notificar a todos para que eliminen la malla de este jugador
    io.emit('playerLeft', { id: socket.id });
  });
});

// ═══════════════════════════════════════════════════════════════
//  🚀  ARRANQUE
// ═══════════════════════════════════════════════════════════════

http.listen(PORT, () => {
  console.log(`[VibeCraft] Servidor escuchando en http://localhost:${PORT}`);
  console.log(`[VibeCraft] Abre http://localhost:${PORT}/index.html en el navegador`);
});