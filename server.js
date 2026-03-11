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
//  ┌──────────────────┬───────────────────────────────────────────────────────┐
//  │ Evento           │ Payload                                               │
//  ├──────────────────┼───────────────────────────────────────────────────────┤
//  │ playerUpdate     │ { id, pos:{x,y,z}, rot:{x,y} }                        │
//  │                  │  Client → Server → broadcast a todos los demás        │
//  ├──────────────────┼───────────────────────────────────────────────────────┤
//  │ blockUpdate      │ { action:'add'|'remove', x,y,z, type, normal }        │
//  │                  │  Client → Server → broadcast a todos los demás        │
//  ├──────────────────┼───────────────────────────────────────────────────────┤
//  │ playerLeft       │ { id }                                                │
//  │                  │  Server → todos, cuando un cliente se desconecta      │
//  └──────────────────┴───────────────────────────────────────────────────────┘
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
//  playerState: Map<socketId, { id, pos, rot, lastSeen }>
//  Solo se usa para enviar el snapshot inicial al jugador recién
//  conectado (no para lógica de juego).
// Semilla compartida: generada una vez al arrancar el servidor.
// Todos los clientes reciben esta semilla y la pasan a Simplex Noise
// para garantizar terrenos idénticos sin intercambiar bloques de terreno.
const SERVER_SEED  = Math.random();
const playerState  = new Map();

// ═══════════════════════════════════════════════════════════════
//  🔌  GESTIÓN DE CONEXIONES
// ═══════════════════════════════════════════════════════════════

io.on('connection', (socket) => {
  console.log(`[VibeCraft] Jugador conectado: ${socket.id}  (total: ${io.engine.clientsCount})`);

  // ── Snapshot inicial ───────────────────────────────────────────
  //  Enviar al recién llegado el estado actual de todos los demás
  //  jugadores para que pueda crear sus mallas inmediatamente.
  // Enviar semilla + snapshot de jugadores en un único evento inicial
  socket.emit('worldInit', {
    seed:    SERVER_SEED,
    players: Array.from(playerState.values()),
  });

  // ── playerUpdate ───────────────────────────────────────────────
  //  Payload: { id, pos: {x,y,z}, rot: {x,y} }
  //  El cliente envía este evento cada frame (throttleado en el cliente).
  //  El servidor actualiza el estado en memoria y hace broadcast.
  socket.on('playerUpdate', (data) => {
    // Validación mínima de tipos para evitar que datos corruptos
    // de un cliente rompan el estado de todos los demás.
    if (
      typeof data?.id  !== 'string'   ||
      typeof data?.pos !== 'object'   ||
      typeof data?.rot !== 'object'
    ) return;

    playerState.set(socket.id, { ...data, lastSeen: Date.now() });
    // broadcast.emit excluye al emisor → solo los OTROS clientes reciben esto
    socket.broadcast.emit('playerUpdate', data);
  });

  // ── blockUpdate ────────────────────────────────────────────────
  //  Payload: { action:'add'|'remove', x,y,z, type, normal }
  //  Retransmite el delta a todos los demás sin procesarlo.
  //  Cada cliente receptor aplica addBlock/removeBlock localmente.
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