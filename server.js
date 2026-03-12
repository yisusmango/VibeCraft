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
//  │ updateSkin           │ base64String (Data URL PNG)                         │
//  │                      │  Client → Server: guarda skin en playerState        │
//  ├──────────────────────┼─────────────────────────────────────────────────────┤
//  │ playerSkinUpdated    │ { id, skin }                                        │
//  │                      │  Server → todos los demás, tras recibir updateSkin  │
//  ├──────────────────────┼─────────────────────────────────────────────────────┤
//  │ playerLeft           │ { id }                                              │
//  │                      │  Server → todos, cuando un cliente se desconecta    │
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
//  playerState: Map<socketId, { id, pos, rot, skin, lastSeen }>
//  • pos / rot  — para el snapshot inicial de posición.
//  • skin       — Data URL Base64 PNG, o null si el jugador no tiene skin.
//  • lastSeen   — timestamp del último playerUpdate recibido.
const SERVER_SEED  = Math.random();
const playerState  = new Map();

// ═══════════════════════════════════════════════════════════════
//  🔌  GESTIÓN DE CONEXIONES
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[VibeCraft] Jugador conectado: ${socket.id}  (total: ${io.engine.clientsCount})`);

  // Inicializar entrada con skin null hasta que el cliente la envíe
  playerState.set(socket.id, {
    id:       socket.id,
    pos:      { x: 0, y: 0, z: 0 },
    rot:      { x: 0, y: 0 },
    skin:     null,
    lastSeen: Date.now(),
  });

  // ── Snapshot inicial ───────────────────────────────────────────
  //  Enviar al recién llegado:
  //   • seed    — semilla de Simplex Noise para generación de terreno.
  //   • players — estado completo de todos los jugadores ya conectados,
  //               incluyendo su propiedad `skin` (puede ser null).
  //  El recién llegado puede así renderizar skins ya aplicadas sin
  //  esperar a un evento playerSkinUpdated posterior.
  socket.emit('worldInit', {
    seed:    SERVER_SEED,
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

  // ── updateSkin ─────────────────────────────────────────────────
  //  Payload: base64String — Data URL completa (data:image/png;base64,…)
  //  Validación básica: debe ser string y comenzar con el prefijo PNG.
  //  Límite de tamaño: 2 MB en caracteres Base64 (~1.5 MB imagen real).
  //  Si no pasa la validación, se ignora silenciosamente.
  socket.on('updateSkin', (base64Skin) => {
    if (
      typeof base64Skin !== 'string'                   ||
      !base64Skin.startsWith('data:image/png;base64,') ||
      base64Skin.length > 2 * 1024 * 1024
    ) {
      console.warn(`[VibeCraft] updateSkin inválida de ${socket.id} — ignorada.`);
      return;
    }

    // Actualizar la skin en playerState preservando el resto del estado
    const existing = playerState.get(socket.id);
    if (existing) {
      existing.skin = base64Skin;
      playerState.set(socket.id, existing);
    }

    console.info(`[VibeCraft] Skin actualizada para ${socket.id} (${(base64Skin.length / 1024).toFixed(1)} KB)`);

    // Notificar a todos los demás para que actualicen la malla del jugador
    socket.broadcast.emit('playerSkinUpdated', {
      id:   socket.id,
      skin: base64Skin,
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