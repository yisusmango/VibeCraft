// ═══════════════════════════════════════════════════════════════
//  src/multiplayer.js  —  Cliente Multijugador de VibeCraft
//  ─────────────────────────────────────────────────────────────
//  Responsabilidades:
//    1. Conectarse al servidor Socket.io en localhost:3000
//    2. Enviar el estado del jugador local (pos + rot) con throttle
//    3. Mantener modelos articulados de otros jugadores (otherPlayers Map)
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
//    THREE.Group generado por createPlayerModel() en SkinModel.js.
//    Si el jugador tiene skin (Data URL Base64 PNG) se aplica la
//    textura con UVs remapeados al atlas Minecraft 64×64.
//    Si no tiene skin, se usa material verde de fallback.
//
//  THROTTLE DE ENVÍO:
//    sendUpdate() acumula el tiempo transcurrido y solo emite un
//    paquete cada SEND_INTERVAL ms (100 ms = 10 Hz). Esto reduce el
//    tráfico de red ~60× frente a enviar cada frame a 60 fps.
//
//  INTERPOLACIÓN:
//    Cada entrada en otherPlayers guarda { group, targetPos, targetRotY, skin }.
//    updateOtherPlayers() hace lerp suave hacia targetPos/targetRotY
//    con factor LERP_FACTOR=0.2 por frame.
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { addBlock, removeBlock, buildChunkMesh, setNoiseSeed } from './world.js';
import { createPlayerModel } from './SkinModel.js';

// ── Configuración ────────────────────────────────────────────────
const SERVER_URL    = 'http://localhost:3000';
const SEND_INTERVAL = 100;   // ms entre paquetes playerUpdate (~10 Hz)
const LERP_FACTOR   = 0.2;   // factor de interpolación por frame

// ── Estado del módulo ────────────────────────────────────────────
let _socket    = null;
let _scene     = null;
let _myId      = null;
let _sendTimer = 0;

// otherPlayers: Map<socketId, { group, targetPos, targetRotY, skin }>
//   group      — THREE.Group devuelto por createPlayerModel()
//   targetPos  — Vector3 objetivo para lerp de posición
//   targetRotY — ángulo Y objetivo para lerp de rotación (yaw)
//   skin       — Data URL Base64 PNG | null
const otherPlayers = new Map();

// ═══════════════════════════════════════════════════════════════
//  🔨  _createPlayerMesh — crea el modelo articulado de un jugador
//
//  Delega en createPlayerModel(skinSource) de SkinModel.js para
//  obtener un THREE.Group con UVs de atlas Minecraft 64×64.
//  Añade el grupo a la escena y lo devuelve.
//
//  @param {THREE.Scene}  scene
//  @param {string|null}  skinSource  — Data URL o null
//  @returns {THREE.Group}
// ═══════════════════════════════════════════════════════════════

function _createPlayerMesh(scene, skinSource) {
  const group = createPlayerModel(skinSource);
  scene.add(group);
  return group;
}

// ── Helper: liberar toda la memoria de un grupo de jugador ───────
//  Recorre el grupo y dispone geometría, textura y material de
//  cada Mesh hijo para evitar fugas de memoria en GPU.
function _disposeGroup(group) {
  group.traverse((child) => {
    if (!child.isMesh) return;
    child.geometry.dispose();
    if (child.material.map) child.material.map.dispose();
    child.material.dispose();
  });
}

// ═══════════════════════════════════════════════════════════════
//  🔌  initMultiplayer — conectar y registrar manejadores de eventos
//  @param {THREE.Scene} scene
// ═══════════════════════════════════════════════════════════════

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
        //  otros jugadores soliciten el snapshot.
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
        //  players[] incluye { id, pos, rot, skin } donde skin es Data
        //  URL o null. _upsertPlayer crea el modelo con la skin correcta.
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
        //  Destruimos el modelo antiguo y creamos uno nuevo con la
        //  textura actualizada, preservando posición y rotación actuales.
        _socket.on('playerSkinUpdated', ({ id, skin }) => {
          if (id === _myId) return;

          const entry = otherPlayers.get(id);
          if (!entry) {
            console.warn(`[VibeCraft MP] playerSkinUpdated para jugador desconocido: ${id}`);
            return;
          }

          // Guardar pose actual antes de destruir el grupo viejo
          const pos  = entry.group.position.clone();
          const rotY = entry.group.rotation.y;

          // Destruir modelo antiguo y liberar recursos GPU
          _scene.remove(entry.group);
          _disposeGroup(entry.group);

          // Crear modelo nuevo con la skin actualizada
          entry.skin  = skin;
          entry.group = _createPlayerMesh(_scene, skin);
          entry.group.position.copy(pos);
          entry.group.rotation.y = rotY;

          console.info(`[VibeCraft MP] Skin actualizada y modelo reconstruido para ${id}.`);
        });

        // ── Sincronización de bloques ─────────────────────────────────
        //  Aplica el delta recibido en el blockMap local y reconstruye
        //  la malla del chunk afectado.
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
            _scene.remove(entry.group);
            _disposeGroup(entry.group);
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
    // Primera vez que vemos a este jugador: crear modelo y registrar.
    // Pasamos skin al constructor para que la textura se aplique
    // directamente desde el snapshot de worldInit si viene incluida.
    const skin     = data.skin ?? null;
    const group    = _createPlayerMesh(_scene, skin);
    const initRotY = data.rot?.y ?? 0;
    group.position.set(data.pos.x, data.pos.y, data.pos.z);
    group.rotation.y = initRotY;
    entry = {
      group,
      targetPos:  new THREE.Vector3(data.pos.x, data.pos.y, data.pos.z),
      targetRotY: initRotY,
      skin,
    };
    otherPlayers.set(data.id, entry);
    console.info(`[VibeCraft MP] Nuevo jugador: ${data.id}${skin ? ' (con skin)' : ''}`);
  } else {
    // Actualizar target para la interpolación en updateOtherPlayers().
    // Solo sobreescribimos skin si viene en el payload — así no borramos
    // una skin ya válida con un playerUpdate que no trae ese campo.
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
//  Hace lerp de la posición actual de cada grupo hacia targetPos,
//  y normaliza + lerp del ángulo Y. El factor LERP_FACTOR=0.2
//  suaviza el movimiento a 10 Hz hasta que parezca 60 Hz.
// ═══════════════════════════════════════════════════════════════

export function updateOtherPlayers() {
  for (const entry of otherPlayers.values()) {
    // Interpolar posición
    entry.group.position.lerp(entry.targetPos, LERP_FACTOR);

    // Interpolar rotación Y tomando el camino angular más corto.
    // ((dy % 2π) + 3π) % 2π - π garantiza resultado en [-π, +π]
    // independientemente del signo de dy (fix para JS donde % preserva signo).
    const TAU    = 2 * Math.PI;
    const dy     = entry.targetRotY - entry.group.rotation.y;
    const dyNorm = ((dy % TAU) + 3 * Math.PI) % TAU - Math.PI;
    entry.group.rotation.y += dyNorm * LERP_FACTOR;
  }
}