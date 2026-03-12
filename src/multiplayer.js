// ═══════════════════════════════════════════════════════════════
//  src/multiplayer.js  —  Cliente Multijugador de VibeCraft
//  ─────────────────────────────────────────────────────────────
//  Responsabilidades:
//    1. Conectarse al servidor Socket.io en localhost:3000
//    2. Enviar el estado del jugador local (pos + rot) con throttle
//    3. Mantener mallas de otros jugadores en la escena (otherPlayers Map)
//    4. Sincronizar eventos de bloque recibidos desde el servidor
//    5. Limpiar mallas al desconectarse un jugador
//    6. Sincronizar skin propia al conectarse y recibir skins remotas
//
//  PROTOCOLO (ver server.js para el contrato completo):
//    Emite  → 'playerUpdate'      { id, pos, rot }          (cada ~100 ms)
//    Emite  → 'blockUpdate'       { action, x,y,z, type, normal }
//    Emite  → 'updateSkin'        base64String              (al conectarse, si hay skin)
//    Recibe ← 'worldInit'         { seed, players }         (snapshot inicial, incluye skins)
//    Recibe ← 'playerUpdate'      { id, pos, rot }          (otros jugadores)
//    Recibe ← 'playerSkinUpdated' { id, skin }              (skin de un jugador actualizada)
//    Recibe ← 'blockUpdate'       { action, x,y,z, type, normal }
//    Recibe ← 'playerLeft'        { id }                    (al desconectarse alguien)
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
//    Cada entrada en otherPlayers guarda { mesh, targetPos, targetRotY, skin }.
//    updateOtherPlayers() hace lerp suave hacia targetPos/targetRotY
//    con factor LERP_FACTOR=0.2 por frame. Esto elimina el "jitter" de
//    paquetes a 10 Hz cuando se visualizan a 60 fps.
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { addBlock, removeBlock, buildChunkMesh, setNoiseSeed } from './world.js';

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

// otherPlayers: Map<socketId, { mesh, targetPos, targetRotY, skin }>
//  • skin — Data URL Base64 PNG guardada en memoria.
//           null si el jugador remoto no tiene skin cargada.
//           Se actualiza vía worldInit (snapshot) o playerSkinUpdated (tiempo real).
//           La aplicación a la malla 3D queda pendiente para la siguiente fase.
const otherPlayers = new Map();

// ── Vector temporal para lerp (evita GC) ───────────────────────
const _lerpPos = new THREE.Vector3();

// ═══════════════════════════════════════════════════════════════
//  🔨  _createPlayerMesh — crea la malla de un jugador remoto
//  ⚠️  INTACTA — no modificar en esta fase. La aplicación de skin
//      a la textura del cubo se implementará en la siguiente iteración.
// ═══════════════════════════════════════════════════════════════

// Material negro reutilizado para bordes + marcador frontal
const _blackMat  = new THREE.MeshBasicMaterial({ color: 0x000000 });

function _createPlayerMesh(scene) {
  const mesh = new THREE.Mesh(_playerGeo, _playerMat);

  // Borde negro con EdgesGeometry para dar contraste estilo voxel
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(_playerGeo),
    new THREE.LineBasicMaterial({ color: 0x000000 })
  );
  mesh.add(edges);

  // ── Marcador Direccional ────────────────────────────────────────
  //  Pequeño cubo negro centrado en la cara FRONTAL del avatar (-Z local).
  //  En Three.js los objetos miran hacia -Z por defecto, igual que la
  //  cámara de PointerLockControls → el marcador apunta en la dirección
  //  a la que mira el jugador remoto, confirmando que la rotación Y
  //  está correctamente sincronizada.
  //
  //  Posición: x=0 (centrado), y=+0.4 (altura de los ojos ≈ EYE_HEIGHT-1),
  //            z=-0.31 (pegado a la cara frontal, mitad grosor = 0.31).
  const noseGeo  = new THREE.BoxGeometry(0.18, 0.18, 0.12);
  const nose     = new THREE.Mesh(noseGeo, _blackMat);
  nose.position.set(0, 0.4, -0.31);
  mesh.add(nose);

  mesh.castShadow    = true;
  mesh.receiveShadow = false;
  scene.add(mesh);
  return mesh;
}

// ═══════════════════════════════════════════════════════════════
//  🔌  initMultiplayer — conectar y registrar manejadores de eventos
//  @param {THREE.Scene} scene
// ═══════════════════════════════════════════════════════════════

/**
 * initMultiplayer — conecta al servidor y retorna una Promise que se
 * resuelve ÚNICAMENTE cuando el servidor envía 'worldInit' con el
 * SERVER_SEED. Esto garantiza que world.js ya tiene la semilla correcta
 * antes de que main.js genere el primer chunk.
 *
 * Si el servidor no está disponible, la Promise se rechaza y main.js
 * puede mostrar un error sin bloquear el resto del juego.
 */
export function initMultiplayer(scene) {
  _scene = scene;

  return new Promise((resolve, reject) => {
    import('http://localhost:3000/socket.io/socket.io.esm.min.js')
      .then(({ io }) => {
        _socket = io(SERVER_URL, {
          reconnectionAttempts: 5,
          timeout: 5000,
        });

        // ── connect: enviar skin propia si existe en localStorage ──────
        //  Se emite justo tras la conexión TCP, antes de recibir worldInit,
        //  para que el servidor ya tenga la skin en playerState cuando
        //  otros jugadores pidan el snapshot (worldInit).
        _socket.on('connect', () => {
          _myId = _socket.id;
          console.info(`[VibeCraft MP] Conectado al servidor. ID: ${_myId}`);

          const skin = localStorage.getItem('vibe_skin');
          if (skin) {
            _socket.emit('updateSkin', skin);
            console.info('[VibeCraft MP] Skin propia enviada al servidor.');
          }
        });

        // connect_error → rechazar la Promise para que await en main.js
        // pueda capturarlo con try/catch y mostrar un error al jugador.
        _socket.on('connect_error', (err) => {
          console.warn('[VibeCraft MP] No se pudo conectar al servidor:', err.message);
          reject(err);
        });

        // ── worldInit: recibir semilla + snapshot completo (con skins) ──
        //  players[] ahora puede incluir { id, pos, rot, skin } donde
        //  skin es Data URL o null. _upsertPlayer guarda skin en el mapa.
        _socket.on('worldInit', ({ seed, players }) => {
          setNoiseSeed(seed);
          console.info(`[VibeCraft MP] Semilla recibida: ${seed.toFixed(8)} — terreno listo.`);
          players.forEach(data => _upsertPlayer(data));
          resolve(seed);
        });

        // ── Actualización de posición de un jugador remoto ───────────
        _socket.on('playerUpdate', (data) => {
          if (data.id === _myId) return;
          _upsertPlayer(data);
        });

        // ── Skin de un jugador remoto actualizada en tiempo real ──────
        //  Llega cuando otro jugador carga una nueva skin estando ya
        //  conectado. Buscamos su entrada en el mapa y guardamos el dato.
        //  La aplicación a la malla 3D (textura) se hará en la siguiente fase.
        _socket.on('playerSkinUpdated', ({ id, skin }) => {
          if (id === _myId) return;  // no procesar eco propio

          const entry = otherPlayers.get(id);
          if (entry) {
            entry.skin = skin;
            console.info(`[VibeCraft MP] Skin recibida para jugador ${id}.`);
          } else {
            // El jugador aún no tiene entrada en el mapa (race condition rara).
            // Se ignorará; cuando llegue su playerUpdate se creará con skin null
            // y la siguiente actualización de skin lo corregirá.
            console.warn(`[VibeCraft MP] playerSkinUpdated para jugador desconocido: ${id}`);
          }
        });

        // ── Sincronización de bloques ─────────────────────────────────
        _socket.on('blockUpdate', (data) => {
          const CS = 16;  // CONFIG.CHUNK_SIZE — inline para evitar import circular
          if (data.action === 'add') {
            addBlock(data.x, data.y, data.z, data.type, data.normal ?? null);
          } else if (data.action === 'remove') {
            removeBlock(data.x, data.y, data.z);
          }
          buildChunkMesh(
            Math.floor(data.x / CS),
            Math.floor(data.z / CS),
          );
        });

        // ── Jugador desconectado ──────────────────────────────────────
        _socket.on('playerLeft', ({ id }) => {
          const entry = otherPlayers.get(id);
          if (entry) {
            _scene.remove(entry.mesh);
            entry.mesh.geometry.dispose();
            otherPlayers.delete(id);
            console.info(`[VibeCraft MP] Jugador ${id} se ha ido.`);
          }
        });

        _socket.on('disconnect', () => {
          console.info('[VibeCraft MP] Desconectado del servidor.');
        });
      })
      .catch((err) => {
        console.info('[VibeCraft MP] Servidor no disponible. Modo single player.');
        reject(err);
      });
  });
}

// ═══════════════════════════════════════════════════════════════
//  🔄  _upsertPlayer — crear o actualizar un jugador remoto
//  @param {{ id, pos:{x,y,z}, rot:{x,y}, skin?:string|null }} data
//
//  La propiedad `skin` es opcional en el payload (ej. playerUpdate
//  no la incluye por eficiencia). Solo se sobreescribe si viene
//  explícitamente en data para no borrar una skin ya guardada.
// ═══════════════════════════════════════════════════════════════

function _upsertPlayer(data) {
  if (!_scene) return;

  let entry = otherPlayers.get(data.id);

  if (!entry) {
    // Primera vez que vemos a este jugador: crear malla y registrar.
    // Guardamos skin desde el snapshot inicial (worldInit) si viene.
    const mesh = _createPlayerMesh(_scene);
    const initRotY = data.rot?.y ?? 0;
    mesh.position.set(data.pos.x, data.pos.y, data.pos.z);
    mesh.rotation.y = initRotY;
    entry = {
      mesh,
      targetPos:  new THREE.Vector3(data.pos.x, data.pos.y, data.pos.z),
      targetRotY: initRotY,
      skin:       data.skin ?? null,   // null si el jugador no tiene skin
    };
    otherPlayers.set(data.id, entry);
    console.info(`[VibeCraft MP] Nuevo jugador: ${data.id}${entry.skin ? ' (con skin)' : ''}`);
  } else {
    // Actualizar target para interpolación.
    // Solo actualizamos skin si viene en el payload (preservar la existente si no).
    entry.targetPos.set(data.pos.x, data.pos.y, data.pos.z);
    entry.targetRotY = data.rot?.y ?? entry.targetRotY;
    if ('skin' in data) {
      entry.skin = data.skin ?? null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  📡  sendUpdate — enviar estado local al servidor (throttleado)
//  ─────────────────────────────────────────────────────────────
//  @param {THREE.Vector3} pos     — posición del jugador local
//  @param {THREE.Camera}  camera  — cámara (para extraer rotación)
// ═══════════════════════════════════════════════════════════════

export function sendUpdate(pos, camera) {
  if (!_socket?.connected) return;

  const now = performance.now();
  if (now - _sendTimer < SEND_INTERVAL) return;
  _sendTimer = now;

  const yawObj = camera.parent;
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
// ═══════════════════════════════════════════════════════════════

export function updateOtherPlayers() {
  for (const entry of otherPlayers.values()) {
    entry.mesh.position.lerp(entry.targetPos, LERP_FACTOR);

    const TAU    = 2 * Math.PI;
    const dy     = entry.targetRotY - entry.mesh.rotation.y;
    const dyNorm = ((dy % TAU) + 3 * Math.PI) % TAU - Math.PI;
    entry.mesh.rotation.y += dyNorm * LERP_FACTOR;
  }
}