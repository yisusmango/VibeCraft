// ═══════════════════════════════════════════════════════════════
//  src/multiplayer.js  —  Cliente Multijugador de VibeCraft
//  ─────────────────────────────────────────────────────────────
//  Responsabilidades:
//    1. Conectarse al servidor Socket.io en localhost:3000
//    2. Enviar el estado del jugador local (pos + rot) con throttle
//    3. Mantener mallas de otros jugadores en la escena (otherPlayers Map)
//    4. Sincronizar eventos de bloque recibidos desde el servidor
//    5. Limpiar mallas al desconectarse un jugador
//
//  PROTOCOLO (ver server.js para el contrato completo):
//    Emite  → 'playerUpdate' { id, pos, rot }   (cada ~100 ms)
//    Emite  → 'blockUpdate'  { action, x,y,z, type, normal }
//    Recibe ← 'playerUpdate' { id, pos, rot }   (otros jugadores)
//    Recibe ← 'playersSnapshot' [...estados]    (al conectarse)
//    Recibe ← 'blockUpdate'  { action, x,y,z, type, normal }
//    Recibe ← 'playerLeft'   { id }             (al desconectarse alguien)
//
//  REPRESENTACIÓN DE OTROS JUGADORES:
//    Cubo 0.6×1.8×0.6 (mismo AABB que el jugador local) con
//    MeshLambertMaterial verde oscuro y borde negro. En la capa final
//    esto se reemplazaría por un modelo con animaciones, pero para
//    el prototipo es suficientemente reconocible sin coste artístico.
//
//  THROTTLE DE ENVÍO:
//    sendUpdate() acumula el tiempo transcurrido y solo emite un
//    paquete cada SEND_INTERVAL ms (100 ms = 10 Hz). Esto reduce el
//    tráfico de red ~60× frente a enviar cada frame a 60 fps, sin
//    impacto perceptible en la suavidad de movimiento de los demás
//    (interpolamos en updateOtherPlayers).
//
//  INTERPOLACIÓN:
//    Cada entrada en otherPlayers guarda { mesh, targetPos, targetRotY }.
//    updateOtherPlayers() hace lerp suave hacia targetPos/targetRotY
//    con factor LERP_FACTOR=0.2 por frame. Esto elimina el "jitter" de
//    paquetes a 10 Hz cuando se visualizan a 60 fps.
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { addBlock, removeBlock } from './world.js';

// ── Configuración ────────────────────────────────────────────────
const SERVER_URL     = 'http://localhost:3000';
const SEND_INTERVAL  = 100;   // ms entre paquetes playerUpdate (~10 Hz)
const LERP_FACTOR    = 0.2;   // factor de interpolación por frame (0=sin mover, 1=snap)

// ── Geometría y material compartidos para todas las mallas remotas ─
//  Creados una sola vez, reutilizados en todas las instancias.
//  Dimensiones = AABB del jugador local (CONFIG.PLAYER_WIDTH × PLAYER_HEIGHT).
const _playerGeo = new THREE.BoxGeometry(0.6, 1.8, 0.6);
const _playerMat = new THREE.MeshLambertMaterial({ color: 0x2e7d32 });  // verde bosque

// ── Estado del módulo ────────────────────────────────────────────
let _socket      = null;   // instancia de Socket.io client
let _scene       = null;   // referencia a la escena Three.js
let _myId        = null;   // socket.id asignado por el servidor
let _sendTimer   = 0;      // acumulador de tiempo para el throttle

// otherPlayers: Map<socketId, { mesh, targetPos, targetRotY }>
const otherPlayers = new Map();

// ── Vector temporal para lerp (evita GC) ───────────────────────
const _lerpPos = new THREE.Vector3();

// ═══════════════════════════════════════════════════════════════
//  🔨  _createPlayerMesh — crea la malla de un jugador remoto
// ═══════════════════════════════════════════════════════════════

function _createPlayerMesh(scene) {
  const mesh = new THREE.Mesh(_playerGeo, _playerMat);

  // Borde negro con EdgesGeometry para dar contraste estilo voxel
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(_playerGeo),
    new THREE.LineBasicMaterial({ color: 0x000000 })
  );
  mesh.add(edges);
  mesh.castShadow    = true;
  mesh.receiveShadow = false;
  scene.add(mesh);
  return mesh;
}

// ═══════════════════════════════════════════════════════════════
//  🔌  initMultiplayer — conectar y registrar manejadores de eventos
//  @param {THREE.Scene} scene
// ═══════════════════════════════════════════════════════════════

export function initMultiplayer(scene) {
  _scene = scene;

  // Carga dinámica de Socket.io client desde el servidor local.
  // Se usa import() dinámico para evitar que el fallo de conexión
  // (ej. servidor apagado) rompa el resto del juego.
  import('http://localhost:3000/socket.io/socket.io.esm.min.js')
    .then(({ io }) => {
      _socket = io(SERVER_URL, {
        // reconnectionAttempts limita cuántas veces reintentamos
        // antes de rendirse — evita bucles de reconexión infinita.
        reconnectionAttempts: 5,
        timeout: 5000,
      });

      _socket.on('connect', () => {
        _myId = _socket.id;
        console.info(`[VibeCraft MP] Conectado al servidor. ID: ${_myId}`);
      });

      _socket.on('connect_error', (err) => {
        console.warn('[VibeCraft MP] No se pudo conectar al servidor:', err.message);
      });

      // ── Snapshot inicial: otros jugadores ya conectados ──────────
      _socket.on('playersSnapshot', (players) => {
        players.forEach(data => _upsertPlayer(data));
      });

      // ── Actualización de posición de un jugador remoto ───────────
      _socket.on('playerUpdate', (data) => {
        if (data.id === _myId) return;   // ignorar eco propio (no debería llegar, pero por si acaso)
        _upsertPlayer(data);
      });

      // ── Sincronización de bloques ─────────────────────────────────
      //  Aplica el delta recibido en el blockMap local.
      //  Usamos los mismos addBlock/removeBlock del módulo world.js,
      //  con rebuild:true para actualizar la malla del chunk afectado.
      _socket.on('blockUpdate', (data) => {
        if (data.action === 'add') {
          addBlock(data.x, data.y, data.z, data.type, data.normal ?? null);
        } else if (data.action === 'remove') {
          removeBlock(data.x, data.y, data.z);
        }
      });

      // ── Jugador desconectado ──────────────────────────────────────
      _socket.on('playerLeft', ({ id }) => {
        const entry = otherPlayers.get(id);
        if (entry) {
          _scene.remove(entry.mesh);
          entry.mesh.geometry.dispose();   // _playerGeo es compartida, no la disposeamos aquí
          otherPlayers.delete(id);
          console.info(`[VibeCraft MP] Jugador ${id} se ha ido.`);
        }
      });

      _socket.on('disconnect', () => {
        console.info('[VibeCraft MP] Desconectado del servidor.');
      });
    })
    .catch(() => {
      // El servidor no está corriendo — el juego continúa en modo single.
      console.info('[VibeCraft MP] Servidor no disponible. Modo single player.');
    });
}

// ═══════════════════════════════════════════════════════════════
//  🔄  _upsertPlayer — crear o actualizar un jugador remoto
//  @param {{ id, pos:{x,y,z}, rot:{x,y} }} data
// ═══════════════════════════════════════════════════════════════

function _upsertPlayer(data) {
  if (!_scene) return;

  let entry = otherPlayers.get(data.id);

  if (!entry) {
    // Primera vez que vemos a este jugador: crear malla y registrar
    const mesh = _createPlayerMesh(_scene);
    mesh.position.set(data.pos.x, data.pos.y, data.pos.z);
    entry = {
      mesh,
      targetPos:  new THREE.Vector3(data.pos.x, data.pos.y, data.pos.z),
      targetRotY: data.rot?.y ?? 0,
    };
    otherPlayers.set(data.id, entry);
    console.info(`[VibeCraft MP] Nuevo jugador: ${data.id}`);
  } else {
    // Actualizar target para la interpolación en updateOtherPlayers()
    entry.targetPos.set(data.pos.x, data.pos.y, data.pos.z);
    entry.targetRotY = data.rot?.y ?? entry.targetRotY;
  }
}

// ═══════════════════════════════════════════════════════════════
//  📡  sendUpdate — enviar estado local al servidor (throttleado)
//  ─────────────────────────────────────────────────────────────
//  @param {THREE.Vector3} pos     — posición del jugador local
//  @param {THREE.Camera}  camera  — cámara (para extraer rotación)
//
//  THROTTLE: solo emite si han pasado ≥ SEND_INTERVAL ms desde el
//  último envío. _sendTimer se actualiza con performance.now().
// ═══════════════════════════════════════════════════════════════

export function sendUpdate(pos, camera) {
  if (!_socket?.connected) return;

  const now = performance.now();
  if (now - _sendTimer < SEND_INTERVAL) return;
  _sendTimer = now;

  // Extraer yaw (Y) del yaw object y pitch (X) de la cámara hija,
  // replicando la misma jerarquía que PointerLockControls usa internamente.
  const yawObj = camera.parent;   // el "yaw object" de PointerLockControls
  _socket.emit('playerUpdate', {
    id:  _myId,
    pos: { x: pos.x, y: pos.y, z: pos.z },
    rot: {
      x: camera.rotation.x,
      y: yawObj ? yawObj.rotation.y : 0,
    },
  });
}

// ═══════════════════════════════════════════════════════════════
//  📡  sendBlockUpdate — avisar al servidor de un cambio de bloque
//  ─────────────────────────────────────────────────────────────
//  Llamar desde interaction.js después de addBlock/removeBlock.
//  @param {'add'|'remove'} action
//  @param {number} x, y, z
//  @param {string} [type]
//  @param {THREE.Vector3|null} [normal]
// ═══════════════════════════════════════════════════════════════

export function sendBlockUpdate(action, x, y, z, type = null, normal = null) {
  if (!_socket?.connected) return;
  _socket.emit('blockUpdate', {
    action, x, y, z, type,
    normal: normal ? { x: normal.x, y: normal.y, z: normal.z } : null,
  });
}

// ═══════════════════════════════════════════════════════════════
//  🔄  updateOtherPlayers — interpolar posiciones (llamar cada frame)
//  ─────────────────────────────────────────────────────────────
//  Hace lerp de la posición actual de cada malla hacia targetPos,
//  y slerp del ángulo Y. El factor LERP_FACTOR=0.2 suaviza el
//  movimiento a 10 Hz hasta que parezca 60 Hz.
// ═══════════════════════════════════════════════════════════════

export function updateOtherPlayers() {
  for (const entry of otherPlayers.values()) {
    // Interpolar posición
    entry.mesh.position.lerp(entry.targetPos, LERP_FACTOR);

    // Interpolar rotación Y (yaw) con ángulo corto
    const dy = entry.targetRotY - entry.mesh.rotation.y;
    // Normalizar a [-π, π] para evitar giros largos en la dirección equivocada
    const dyNorm = ((dy + Math.PI) % (2 * Math.PI)) - Math.PI;
    entry.mesh.rotation.y += dyNorm * LERP_FACTOR;
  }
}