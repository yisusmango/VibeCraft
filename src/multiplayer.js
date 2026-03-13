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

// otherPlayers: Map<socketId, { group, targetPos, targetRotY, targetRotX, walkPhase, skin }>
//   group      — THREE.Group devuelto por createPlayerModel()
//   targetPos  — Vector3 objetivo para lerp de posición
//   targetRotY — yaw de CÁMARA del jugador remoto (no el del cuerpo).
//                El cuerpo (group.rotation.y) se desacopla de este valor:
//                sigue la cámara al caminar, pero en reposo solo rota
//                si el ángulo de cuello supera ±45°. La cabeza
//                (parts.head.rotation.y) absorbe el resto del giro.
//   targetRotX — pitch de cámara para el asentido vertical de la cabeza
//   walkPhase  — acumulador del ciclo de caminata (radianes)
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
      targetRotX: data.rot?.x ?? 0,   // pitch para el asentido de cabeza
      walkPhase:  0,                   // acumulador del ciclo de caminata
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
    entry.targetRotX = data.rot?.x ?? entry.targetRotX;
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
//
//  EXTRACCIÓN DE ÁNGULOS — orden YXZ:
//  camera.rotation usa el orden por defecto XYZ. Al mirar hacia el sur
//  (>90°) ese orden produce Gimbal Lock e invierte el eje X, haciendo que
//  el pitch se lea negativo cuando debería ser positivo.
//  Descomponer el quaternion con orden YXZ da siempre yaw en .y y pitch
//  real en .x, sin singularidades en ningún ángulo de visión.
// ═══════════════════════════════════════════════════════════════

// Euler reutilizable — evita allocar un objeto por frame (100 Hz × N jugadores).
const _sendEuler = new THREE.Euler(0, 0, 0, 'YXZ');

export function sendUpdate(pos, camera) {
  if (!_socket?.connected) return;

  const now = performance.now();
  if (now - _sendTimer < SEND_INTERVAL) return;
  _sendTimer = now;

  // Descomponer el quaternion de la cámara en orden YXZ para obtener
  // pitch (.x) y yaw (.y) correctos en todo el rango de rotación.
  _sendEuler.setFromQuaternion(camera.quaternion);

  _socket.emit('playerUpdate', {
    id:  _myId,
    pos: { x: pos.x, y: pos.y, z: pos.z },
    rot: {
      x: _sendEuler.x,   // pitch real, sin inversión al mirar atrás
      y: _sendEuler.y,   // yaw real,   sin Gimbal Lock
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
//  normalizeAngle(a) → número en [-π, +π]
//  ─────────────────────────────────────────────────────────────
//  El operador % de JS preserva el signo del dividendo, por lo que
//  un ángulo negativo grande NO se normaliza correctamente con la
//  fórmula simple (a % TAU - PI). Añadir 1.5*TAU antes del módulo
//  garantiza que el operando sea positivo para cualquier entrada.
//
//  Ejemplos:
//    normalizeAngle(-5) → -5 + 6π ≡ 1.28 rad (mod 2π) → -4.99 … NO
//    normalizeAngle(-5) con 1.5*TAU → siempre en [-π, π]  ✓
// ═══════════════════════════════════════════════════════════════

const TAU = 2 * Math.PI;
const normalizeAngle = (a) => ((a % TAU) + 1.5 * TAU) % TAU - Math.PI;

// ═══════════════════════════════════════════════════════════════
//  🔄  updateOtherPlayers — interpolar posiciones + animar huesos
//  ─────────────────────────────────────────────────────────────
//  Llamar cada frame desde el game loop de main.js.
//
//  ─── DECOUPLED HEAD YAW (rotación de cabeza desacoplada) ────────
//
//  El cuerpo (group.rotation.y) y la cabeza (parts.head.rotation.y)
//  se gestionan de forma independiente, igual que en Minecraft Java:
//
//  Al CAMINAR (movedXZ > 0.001):
//    El cuerpo interpola directamente hacia targetRotY (yaw cámara).
//    La cabeza absorbe el residuo (≈ 0) con lerp rápido.
//
//  En REPOSO (movedXZ ≤ 0.001):
//    El cuerpo NO rota a menos que |yawDiff| supere MAX_NECK (45°).
//    Cuando lo supera, el objetivo del cuerpo se ajusta para mantener
//    la diferencia en exactamente ±45°, y el cuerpo interpola hacia
//    ese objetivo (da la sensación de que los hombros "se rinden").
//    La cabeza gira el ángulo residual completo con lerp rápido (0.5),
//    lo que produce el movimiento independiente característico de MC.
// ═══════════════════════════════════════════════════════════════

export function updateOtherPlayers() {
  const MAX_NECK = Math.PI / 4;   // 45° — límite de tensión del cuello

  for (const entry of otherPlayers.values()) {

    // ── Distancia XZ recorrida en este frame ─────────────────────
    //  Capturamos X/Z ANTES del lerp para medir el desplazamiento
    //  real de la malla sin allocar un Vector3 extra por frame.
    const prevX = entry.group.position.x;
    const prevZ = entry.group.position.z;

    entry.group.position.lerp(entry.targetPos, LERP_FACTOR);

    const movedXZ = Math.sqrt(
      (entry.group.position.x - prevX) ** 2 +
      (entry.group.position.z - prevZ) ** 2,
    );

    // ── Walk phase ────────────────────────────────────────────────
    //  Acumula fase proporcional a la velocidad mientras se camina.
    //  Decae exponencialmente al detenerse para volver a pose de reposo.
    if (movedXZ > 0.001) {
      entry.walkPhase += movedXZ * 12;   // ~paso natural a velocidad normal
    } else {
      entry.walkPhase *= 0.85;           // decay suave hacia 0
    }

    // ── Decoupled Head Yaw ────────────────────────────────────────
    //  yawDiff: diferencia normalizada entre la mirada de cámara
    //  y la orientación actual del cuerpo.
    const yawDiff = normalizeAngle(entry.targetRotY - entry.group.rotation.y);

    if (movedXZ > 0.001) {
      // Caminando: cuerpo sigue la cámara con lerp normal.
      entry.group.rotation.y += yawDiff * LERP_FACTOR;
    } else {
      // En reposo: el cuerpo solo cede si el cuello está demasiado girado.
      if (Math.abs(yawDiff) > MAX_NECK) {
        // Calcular el objetivo del cuerpo para que yawDiff quede en ±MAX_NECK.
        // Si yawDiff > 0 (mirando a la derecha): bodyTarget = cámara - MAX_NECK
        // Si yawDiff < 0 (mirando a la izquierda): bodyTarget = cámara + MAX_NECK
        const sign       = yawDiff > 0 ? 1 : -1;
        const bodyTarget = normalizeAngle(entry.targetRotY - sign * MAX_NECK);
        const dBody      = normalizeAngle(bodyTarget - entry.group.rotation.y);
        entry.group.rotation.y += dBody * LERP_FACTOR;
      }
      // Si |yawDiff| ≤ 45°: cuerpo quieto, la cabeza absorbe todo el giro.
    }

    // ── Rotación local de la cabeza (yaw residual) ───────────────
    //  Recalculamos yawDiff después de que el cuerpo haya podido girar
    //  en este frame. La cabeza se mueve con lerp rápido (0.5) para
    //  que la respuesta sea inmediata y fluida.
    const headYaw = normalizeAngle(entry.targetRotY - entry.group.rotation.y);

    // ── Animación de huesos ───────────────────────────────────────
    const parts = entry.group.userData;
    if (!parts?.head) continue;   // guardia: modelo sin userData (fallback verde)

    // Head pitch (arriba/abajo) — lerp normal
    parts.head.rotation.x +=
      (entry.targetRotX - parts.head.rotation.x) * LERP_FACTOR;

    // Head yaw (izquierda/derecha) — lerp rápido para respuesta inmediata
    parts.head.rotation.y += (headYaw - parts.head.rotation.y) * 0.5;

    // Walk swing: oscilación cruzada brazos ↔ piernas, estilo Minecraft
    const swing = Math.sin(entry.walkPhase) * (Math.PI / 4);
    parts.armR.rotation.x =  swing;
    parts.armL.rotation.x = -swing;
    parts.legR.rotation.x = -swing;
    parts.legL.rotation.x =  swing;
  }
}