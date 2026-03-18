// ═══════════════════════════════════════════════════════════════
//  src/multiplayer.js  —  Cliente Multijugador de VibeCraft
//  ─────────────────────────────────────────────────────────────
//  Responsabilidades:
//    1. Conectarse al servidor Socket.io en localhost:3000
//    2. Enviar el estado del jugador local (pos + rot + heldItem) con throttle
//    3. Mantener modelos articulados de otros jugadores (otherPlayers Map)
//    4. Sincronizar eventos de bloque recibidos desde el servidor
//    5. Limpiar mallas al desconectarse un jugador
//    6. Sincronizar skin propia al conectarse y recibir skins remotas
//    7. Renderizar el ítem en la mano (heldItem) de jugadores remotos
//    8. Sincronizar el ciclo de día/noche con el servidor
//       ─ worldInit:     recibe dayT inicial → environment.setDayT(dayT)
//       ─ timeUpdate:    recibe corrección periódica (dead-band 0.05)
//       ─ adminTimeUpdate: emite cambio manual de hora al servidor
//
//  PROTOCOLO (ver server.js para el contrato completo):
//    Emite  → 'playerUpdate'      { id, pos, rot, heldItem }   (cada ~100 ms)
//    Emite  → 'blockUpdate'       { action, x,y,z, type, normal }
//    Emite  → 'updateProfile'     { skin, username }           (al conectarse)
//    Emite  → 'adminTimeUpdate'   { dayT }                     (cambio manual de hora)
//    Recibe ← 'worldInit'         { seed, dayT, players }      (snapshot inicial)
//    Recibe ← 'playerUpdate'      { id, pos, rot, heldItem }   (otros jugadores)
//    Recibe ← 'playerProfileUpdated' { id, skin, username }    (perfil actualizado)
//    Recibe ← 'blockUpdate'       { action, x,y,z, type, normal }
//    Recibe ← 'playerLeft'        { id }                       (desconexión)
//    Recibe ← 'chatMessage'       { username, message }
//    Recibe ← 'timeUpdate'        { dayT }        (corrección periódica, 10 s)
//    Emite  → 'chatMessage'       string
//
//  MODELO DE SINCRONIZACIÓN DE TIEMPO (Reloj Local Sincronizado):
//    El reloj del cliente avanza SIEMPRE localmente frame a frame para
//    garantizar sombras y animaciones sin saltos.
//    timeUpdate usa un dead-band de 0.05 (wrap-aware): solo hace snap
//    vía setDayT() si la diferencia es mayor. Si el cliente ya está
//    cerca del valor del servidor, ignora el paquete y sigue fluido.
//    adminTimeUpdate propaga cambios manuales de hora al servidor para
//    que todos los demás clientes se sincronicen inmediatamente.
//
//  REPRESENTACIÓN DE OTROS JUGADORES:
//    THREE.Group generado por createPlayerModel() en SkinModel.js.
//    Si el jugador tiene skin (Data URL Base64 PNG) se aplica la
//    textura con UVs remapeados al atlas Minecraft 64×64.
//    Si no tiene skin, se usa material verde de fallback.
//
//  HELD ITEM (ítem en mano):
//    Un THREE.Mesh(BoxGeometry(0.25,0.25,0.25), MATERIALS[type]) se
//    adjunta como hijo de entry.group.userData.armR. Al ser hijo del
//    brazo derecho, hereda el walk swing automáticamente sin cálculo
//    adicional. Los materiales de MATERIALS son singletons globales
//    (no se disponen al limpiar el mesh; solo se dispone la geometría).
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
import { addBlock, removeBlock, buildChunkMesh, setNoiseSeed, MATERIALS } from './world.js';
import { createPlayerModel } from './SkinModel.js';
import { addChatMessage, getCurrentBlockType } from './ui.js';

// ── Configuración ────────────────────────────────────────────────
const SERVER_URL    = 'http://localhost:3000';
const SEND_INTERVAL = 100;   // ms entre paquetes playerUpdate (~10 Hz)
const LERP_FACTOR   = 0.2;   // factor de interpolación por frame

// ── Dead-band de sincronización de tiempo ───────────────────────
//  Si la diferencia wrap-aware entre el dayT del servidor y el del cliente
//  es menor que este umbral, se ignora el timeUpdate y el reloj local
//  sigue avanzando sin interrupciones → sombras y animaciones fluidas.
//  Si es mayor, se hace snap vía setDayT() para corregir la deriva.
//  Valor 0.05 ≈ 1 minuto de ciclo (ciclo total = 1200 s = 20 min).
const TIME_SNAP_THRESHOLD = 0.05;

// ── Estado del módulo ────────────────────────────────────────────
let _socket      = null;
let _scene       = null;
let _myId        = null;
let _sendTimer   = 0;

// ── Referencia al Environment para sincronización de tiempo ──────
//  Se asigna cuando main.js llama initMultiplayer(scene, environment).
//  Null en los períodos en los que no hay sesión multijugador activa.
//  Todos los accesos deben hacer guard: if (_environment) { … }
let _environment = null;

const REMOTE_PUNCH_DURATION = 0.20;
const REMOTE_PUNCH_ANGLE    = Math.PI / 3;

// otherPlayers: Map<socketId, {
//   group,       — THREE.Group devuelto por createPlayerModel()
//   targetPos,   — Vector3 objetivo para lerp de posición
//   targetRotY,  — yaw de CÁMARA del jugador remoto (no el del cuerpo).
//                  El cuerpo (group.rotation.y) se desacopla de este valor:
//                  sigue la cámara al caminar, pero en reposo solo rota
//                  si el ángulo de cuello supera ±45°. La cabeza
//                  (parts.head.rotation.y) absorbe el resto del giro.
//   targetRotX,  — pitch de cámara para el asentido vertical de la cabeza
//   walkPhase,   — acumulador del ciclo de caminata (radianes)
//   skin,        — Data URL Base64 PNG | null
//   username,    — string mostrado en el name tag flotante
//   sprite,      — THREE.Sprite del name tag (hijo del group)
//   heldItem,    — string del tipo de bloque sostenido actualmente | null
//   heldMesh,    — THREE.Mesh del mini-bloque en mano | null
// }>
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

// ═══════════════════════════════════════════════════════════════
//  🖐️  _updateHeldItem — sincronizar el mini-bloque en la mano
//  ─────────────────────────────────────────────────────────────
//  Si el tipo no cambió, no hace nada (evita recrear geometría
//  cada frame innecesariamente).
//
//  Si cambió, destruye el mesh anterior y crea uno nuevo como
//  hijo de armR. Al ser hijo del brazo derecho hereda el walk
//  swing automáticamente sin cálculo adicional.
//
//  ⚠️  IMPORTANTE — gestión de materiales compartidos:
//    MATERIALS[type] son singletons globales usados también por
//    los InstancedMeshes del terreno. NO se deben disponer aquí.
//    Marcamos el heldMesh con userData.sharedMaterial = true para
//    que _disposeGroup lo omita al limpiar materiales.
//    Solo se dispone la BoxGeometry, que sí es instancia propia.
//
//  @param {{ heldItem:string|null, heldMesh:THREE.Mesh|null,
//            group:THREE.Group }} entry
//  @param {string|null} newType
// ═══════════════════════════════════════════════════════════════

function _updateHeldItem(entry, newType) {
  // No-op si el tipo no cambió — evita trabajo innecesario cada playerUpdate.
  if (entry.heldItem === newType) return;

  // ── Destruir el mesh anterior ─────────────────────────────────
  if (entry.heldMesh) {
    entry.heldMesh.removeFromParent();
    // Solo disponer la geometría: el material es un singleton global de MATERIALS.
    entry.heldMesh.geometry.dispose();
    entry.heldMesh = null;
  }

  entry.heldItem = newType;

  // ── Crear el nuevo mesh si el tipo es válido ──────────────────
  if (newType && MATERIALS[newType]) {
    const geo  = new THREE.BoxGeometry(0.25, 0.25, 0.25);
    // MATERIALS[newType] puede ser un array de 6 materiales (multi-material)
    // o un único material. THREE.Mesh acepta ambos formatos con BoxGeometry.
    const mesh = new THREE.Mesh(geo, MATERIALS[newType]);

    // Señal para que _disposeGroup no intente disponer materiales compartidos.
    mesh.userData.sharedMaterial = true;

    // Posición relativa al brazo derecho:
    // Y = -0.70 → A la altura de la mano (el brazo mide 0.75; -0.35 era el codo)
    // Z = -0.15 → Hacia el frente (el personaje mira hacia -Z, positivo = espalda)
    mesh.position.set(0, -0.70, -0.15);
    mesh.castShadow = false;

    // Adjuntar como hijo del brazo derecho para heredar el walk swing
    const armR = entry.group.userData?.armR;
    if (armR) {
      armR.add(mesh);
      entry.heldMesh = mesh;
    } else {
      // Fallback: el modelo no tiene armR (p.ej. modelo de emergencia oculto)
      geo.dispose();
    }
  }
}

// ── Helper: liberar toda la memoria de un grupo de jugador ───────
//  Recorre el grupo y dispone geometría, textura y material de
//  cada Mesh hijo. Los Sprite de name tag también se limpian:
//  su material.map es un CanvasTexture que hay que liberar
//  explícitamente para evitar fugas de memoria en GPU.
//
//  ⚠️  Meshes con userData.sharedMaterial = true (heldMesh):
//    Solo se dispone su geometría. Su material pertenece al objeto
//    global MATERIALS de world.js y NO debe destruirse aquí.
function _disposeGroup(group) {
  group.traverse((child) => {
    if (child.isSprite) {
      // Name tag: liberar CanvasTexture + SpriteMaterial
      if (child.material.map) child.material.map.dispose();
      child.material.dispose();
      return;
    }
    if (!child.isMesh) return;

    child.geometry.dispose();

    // Omitir la destrucción del material en meshes que comparten
    // materiales globales (heldMesh) para no corromper el terreno.
    if (child.userData.sharedMaterial) return;

    if (child.material.map) child.material.map.dispose();
    child.material.dispose();
  });
}

// ═══════════════════════════════════════════════════════════════
//  🔌  initMultiplayer — conectar y registrar manejadores de eventos
//  ─────────────────────────────────────────────────────────────
//  @param {THREE.Scene}      scene       — Escena Three.js principal
//  @param {Environment|null} environment
//    Instancia del ciclo día/noche. Si se proporciona, se sincroniza
//    el reloj con el servidor vía setDayT() al recibir worldInit y
//    timeUpdate (con dead-band). Puede ser null en tests.
// ═══════════════════════════════════════════════════════════════

export function initMultiplayer(scene, environment = null) {
  _scene       = scene;
  _environment = environment;

  return new Promise((resolve, reject) => {
    import('http://localhost:3000/socket.io/socket.io.esm.min.js')
      .then(({ io }) => {
        _socket = io(SERVER_URL, {
          reconnectionAttempts: 5,
          timeout: 5000,
        });

        // ── connect: enviar perfil propio (skin + username) al servidor ──
        //  Se emite justo tras la conexión TCP, antes de recibir worldInit,
        //  para que el servidor ya tenga el perfil en playerState cuando
        //  otros jugadores soliciten el snapshot.
        _socket.on('connect', () => {
          _myId = _socket.id;
          console.info(`[VibeCraft MP] Conectado al servidor. ID: ${_myId}`);

          const skin     = localStorage.getItem('vibe_skin')     ?? null;
          const username = localStorage.getItem('vibe_username') ?? null;
          _socket.emit('updateProfile', { skin, username });
          console.info('[VibeCraft MP] Perfil propio enviado al servidor.');
        });

        // connect_error → rechazar la Promise para que await en main.js
        // pueda capturarlo con try/catch y mostrar un error al jugador.
        _socket.on('connect_error', (err) => {
          console.warn('[VibeCraft MP] No se pudo conectar al servidor:', err.message);
          reject(err);
        });

        // ── worldInit: recibir semilla + dayT + snapshot completo ─────
        //  Payload: { seed, dayT, players }
        //    seed    — semilla de Simplex Noise para generación de terreno.
        //    dayT    — progreso actual del ciclo de día/noche [0, 1).
        //              Siempre se hace snap en worldInit (sincronización inicial),
        //              independientemente del dead-band, porque el cliente acaba
        //              de arrancar y su reloj parte de 0.
        //    players — snapshot completo de jugadores conectados.
        _socket.on('worldInit', ({ seed, dayT, players }) => {
          setNoiseSeed(seed);
          console.info(`[VibeCraft MP] Semilla recibida: ${seed.toFixed(8)} — terreno listo.`);

          // Snap incondicional en la sincronización inicial: el reloj del
          // cliente parte de 0 y debe saltar al tiempo actual del servidor.
          if (_environment && typeof dayT === 'number') {
            _environment.setDayT(dayT);
            console.info(`[VibeCraft MP] Reloj sincronizado (worldInit): dayT=${dayT.toFixed(4)}`);
          }

          players.forEach(data => {
            if (data.id !== _myId) _upsertPlayer(data);
          });
          resolve(seed);
        });

        // ── Actualización de posición de un jugador remoto ───────────
        _socket.on('playerUpdate', (data) => {
          if (data.id === _myId) return;
          _upsertPlayer(data);
        });

        // ── Perfil de un jugador remoto actualizado en tiempo real ────
        //  Destruimos el modelo antiguo y creamos uno nuevo con la
        //  skin y/o username actualizados, preservando pose actual.
        _socket.on('playerProfileUpdated', ({ id, skin, username }) => {
          if (id === _myId) return;

          let entry = otherPlayers.get(id);
          if (!entry) {
            // Condición de carrera: playerProfileUpdated llegó antes que el primer
            // playerUpdate. Creamos un jugador temporal oculto (Y=-1000) con el
            // perfil correcto; cuando llegue playerUpdate lo reposicionará.
            _upsertPlayer({
              id,
              pos: { x: 0, y: -1000, z: 0 },
              rot: { x: 0, y: 0 },
              skin,
              username,
            });
            return;
          }

          // Guardar pose actual antes de destruir el grupo viejo
          const pos      = entry.group.position.clone();
          const rotY     = entry.group.rotation.y;
          // Capturar el tipo de ítem para re-aplicarlo en el modelo nuevo
          const prevHeld = entry.heldItem;

          // Destruir modelo antiguo y liberar recursos GPU
          // (heldMesh incluido vía traverse — geometría sí, material no)
          _scene.remove(entry.group);
          _disposeGroup(entry.group);
          entry.heldMesh = null;   // ya destruido por _disposeGroup

          // Actualizar campos del perfil solo si vienen en el payload
          if (skin     !== null && skin     !== undefined) entry.skin     = skin;
          if (username !== null && username !== undefined) entry.username = username;

          // Crear modelo nuevo con skin actualizada + nuevo name tag
          entry.group = _createPlayerMesh(_scene, entry.skin);
          entry.group.position.copy(pos);
          entry.group.rotation.y = rotY;

          // Regenerar name tag con el username actualizado
          entry.sprite = _createNameTagSprite(entry.username);
          entry.sprite.position.set(0, 2.2, 0);
          entry.group.add(entry.sprite);

          // Restaurar el ítem en la mano sobre el nuevo modelo
          // (forzamos heldItem a null para que _updateHeldItem no haga no-op)
          entry.heldItem = null;
          _updateHeldItem(entry, prevHeld);

          console.info(`[VibeCraft MP] Perfil actualizado y modelo reconstruido para ${id}.`);
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

        // ── Acción de punch remoto ────────────────────────────────────
        _socket.on('playerAction', ({ id, action }) => {
          if (id === _myId) return;
          if (action === 'punch') {
            const entry = otherPlayers.get(id);
            if (entry) entry.punchTimer = 0;
          }
        });

        // ── Corrección periódica del reloj día/noche (dead-band) ──────
        //
        //  MODELO "RELOJ LOCAL SINCRONIZADO":
        //  El reloj cliente ya avanza localmente en environment.update().
        //  Este handler solo hace snap (setDayT) si la diferencia entre
        //  el tiempo del servidor y el local supera TIME_SNAP_THRESHOLD (0.05).
        //  Para diferencias menores, se ignora el paquete → fluidez total.
        //
        //  DIFERENCIA WRAP-AWARE:
        //  El ciclo dayT va de 0 a 1 y hace wrap. Una diferencia naive
        //  de 0.96 entre server=0.98 y local=0.02 parecería un desfase
        //  grande, pero en realidad son solo 0.04 aparte (cruzando el 0/1).
        //  La corrección: si diff > 0.5 entonces diff = 1.0 - diff.
        //  Esto garantiza que siempre comparamos la distancia más corta
        //  en el ciclo circular.
        //
        //  También se emite desde adminTimeUpdate (cambio manual de hora),
        //  en cuyo caso la diferencia suele ser grande → siempre hace snap.
        //
        //  Guards:
        //    • _environment !== null — no hay sesión multijugador activa.
        //    • typeof data?.dayT === 'number' — payload malformado o servidor antiguo.
        _socket.on('timeUpdate', (data) => {
          if (!(_environment && typeof data?.dayT === 'number')) return;

          const serverTime = data.dayT;
          const localTime  = _environment.dayT;

          // Diferencia wrap-aware en el ciclo [0, 1)
          let diff = Math.abs(serverTime - localTime);
          if (diff > 0.5) diff = 1.0 - diff;

          if (diff > TIME_SNAP_THRESHOLD) {
            // Desincronización significativa → snap al valor canónico del servidor
            _environment.setDayT(serverTime);
            console.info(
              `[VibeCraft MP] timeUpdate snap: local=${localTime.toFixed(4)} ` +
              `server=${serverTime.toFixed(4)} diff=${diff.toFixed(4)}`
            );
          }
          // diff ≤ TIME_SNAP_THRESHOLD → el cliente ya está sincronizado,
          // seguir avanzando localmente para máxima fluidez.
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

        // ── Mensaje de chat recibido ──────────────────────────────────
        //  Retransmitido por el servidor desde otro jugador.
        //  addChatMessage() añade el mensaje al panel de chat en la UI.
        _socket.on('chatMessage', (data) => {
          addChatMessage(data.username, data.message);
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
//  🏷️  _createNameTagSprite — genera un Sprite con el nombre
//  ─────────────────────────────────────────────────────────────
//  Dibuja el username sobre un <canvas> en memoria, genera un
//  CanvasTexture y devuelve un THREE.Sprite listo para añadir
//  al grupo del jugador. El sprite usa transparencia, por lo que
//  solo el texto (y su sombra) son visibles sobre el mundo 3D.
//
//  Tipografía: 'Press Start 2P' si ya está cargada en el DOM
//  (la carga la página principal); si no, cae a Courier New.
//
//  @param {string} username
//  @returns {THREE.Sprite}
// ═══════════════════════════════════════════════════════════════

function _createNameTagSprite(username) {
  const CW = 256, CH = 64;   // dimensiones del canvas en píxeles

  const canvas = document.createElement('canvas');
  canvas.width  = CW;
  canvas.height = CH;
  const ctx = canvas.getContext('2d');

  // Fondo semitransparente (pastilla oscura, estilo Minecraft)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  const pad = 8;
  ctx.beginPath();
  ctx.roundRect(pad, CH / 2 - 20, CW - pad * 2, 36, 6);
  ctx.fill();

  // Tipografía
  const fontFace = document.fonts?.check('12px "Press Start 2P"')
    ? '"Press Start 2P"'
    : 'Courier New';
  const fontSize = 20;
  ctx.font      = `bold ${fontSize}px ${fontFace}`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';

  // Contorno oscuro para legibilidad contra cielo y terreno
  ctx.lineWidth   = 4;
  ctx.strokeStyle = '#000000';
  ctx.strokeText(username, CW / 2, CH / 2);

  // Texto blanco
  ctx.fillStyle = '#ffffff';
  ctx.fillText(username, CW / 2, CH / 2);

  // Textura y material
  const texture  = new THREE.CanvasTexture(canvas);
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite   = new THREE.Sprite(material);

  // Escala en unidades Three.js: relación de aspecto 256:64 = 4:1
  // → ancho 1.5u, alto 0.375u. Ajusta el primer valor para hacerlo mayor/menor.
  sprite.scale.set(1.5, 0.375, 1);
  sprite.renderOrder = 999;   // siempre visible, no oculto por otras mallas

  return sprite;
}

// ═══════════════════════════════════════════════════════════════
//  🔄  _upsertPlayer — crear o actualizar un jugador remoto
//  @param {{ id, pos:{x,y,z}, rot:{x,y}, skin?:string|null,
//            heldItem?:string|null }} data
//
//  La propiedad `skin` es opcional en el payload (ej. playerUpdate
//  no la incluye por eficiencia). Solo se sobreescribe si viene
//  explícitamente en data para no borrar una skin ya guardada.
//  Lo mismo aplica para `heldItem`: se llama a _updateHeldItem
//  solo si el campo viene en el payload.
// ═══════════════════════════════════════════════════════════════

function _upsertPlayer(data) {
  if (!_scene) return;

  let entry = otherPlayers.get(data.id);

  if (!entry) {
    // Primera vez que vemos a este jugador: crear modelo y registrar.
    // Pasamos skin al constructor para que la textura se aplique
    // directamente desde el snapshot de worldInit si viene incluida.
    const skin     = data.skin ?? null;
    const username = data.username ?? 'Player';
    const group    = _createPlayerMesh(_scene, skin);
    const initRotY = data.rot?.y ?? 0;
    group.position.set(data.pos.x, data.pos.y, data.pos.z);
    group.rotation.y = initRotY;

    // Generar name tag flotante y añadirlo como hijo del grupo
    // para que se mueva y rote solidariamente con el modelo.
    const sprite = _createNameTagSprite(username);
    sprite.position.set(0, 2.2, 0);   // sobre la cabeza (altura ~2u + margen)
    group.add(sprite);

    entry = {
      group,
      targetPos:  new THREE.Vector3(data.pos.x, data.pos.y, data.pos.z),
      targetRotY: initRotY,
      targetRotX: data.rot?.x ?? 0,   // pitch para el asentido de cabeza
      walkPhase:  0,                   // acumulador del ciclo de caminata
      punchTimer: -1,                  // <0 = no punching; ≥0 = animando
      skin,
      username,
      sprite,
      heldItem:   null,                // tipo de bloque en mano (string | null)
      heldMesh:   null,                // THREE.Mesh del mini-bloque | null
    };
    otherPlayers.set(data.id, entry);
    console.info(`[VibeCraft MP] Nuevo jugador: ${data.id} (${username})${skin ? ' (con skin)' : ''}`);

    // Aplicar el ítem en mano si viene en el snapshot inicial
    if ('heldItem' in data) {
      _updateHeldItem(entry, data.heldItem ?? null);
    }
  } else {
    // Actualizar target para la interpolación en updateOtherPlayers().
    // Solo sobreescribimos skin/username si vienen en el payload — así no
    // borramos valores ya válidos con un playerUpdate que no trae esos campos.
    entry.targetPos.set(data.pos.x, data.pos.y, data.pos.z);
    entry.targetRotY = data.rot?.y ?? entry.targetRotY;
    entry.targetRotX = data.rot?.x ?? entry.targetRotX;
    if ('skin' in data)     entry.skin     = data.skin     ?? null;
    if ('username' in data) entry.username = data.username ?? entry.username;

    // Actualizar el ítem en mano solo si viene en el payload para no
    // resetear el mesh en playerUpdates que no incluyen este campo.
    if ('heldItem' in data) {
      _updateHeldItem(entry, data.heldItem ?? null);
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
//  ─────────────────────────────────────────────────────────────
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
    heldItem: getCurrentBlockType(),  // tipo de bloque seleccionado en el hotbar
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

export function sendPunchAction() {
  if (!_socket?.connected) return;
  _socket.emit('playerAction', { action: 'punch' });
}

// ═══════════════════════════════════════════════════════════════
//  📡  sendChatMessage — emitir un mensaje de chat al servidor
//  ─────────────────────────────────────────────────────────────
//  @param {string} msg — texto del mensaje (ya validado en la UI)
// ═══════════════════════════════════════════════════════════════

export function sendChatMessage(msg) {
  if (!_socket?.connected) return;
  _socket.emit('chatMessage', msg);
}

// ═══════════════════════════════════════════════════════════════
//  📡  sendAdminTimeUpdate — propagar un cambio manual de hora
//  ─────────────────────────────────────────────────────────────
//  Llamado desde main.js cuando el jugador usa los Dev Tools o
//  los atajos de teclado (U/I/O/P) mientras está en multijugador.
//
//  El servidor recibe el nuevo dayT, actualiza globalDayT y emite
//  timeUpdate a TODOS los clientes para sincronización inmediata.
//  Los demás clientes aplicarán snap (diferencia grande) o ignorarán
//  (ya sincronizados) según su dead-band individual.
//
//  Guard: solo emite si el socket está conectado; en singleplayer
//  esta función es un no-op silencioso.
//
//  @param {number} time — dayT actual del environment local [0, 1)
// ═══════════════════════════════════════════════════════════════

export function sendAdminTimeUpdate(time) {
  if (!_socket?.connected) return;
  _socket.emit('adminTimeUpdate', { dayT: time });
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
    parts.armL.rotation.x = -swing;
    parts.legR.rotation.x = -swing;
    parts.legL.rotation.x =  swing;

    // Punch override en armR: si punchTimer ≥ 0, animar golpe rápido
    if (entry.punchTimer >= 0) {
      entry.punchTimer += 0.016;
      const t          = Math.min(entry.punchTimer / REMOTE_PUNCH_DURATION, 1);
      const punchAnim  = Math.sin(t * Math.PI);
      // HOTFIX v0.3.1 — signo corregido: suma swing + ángulo de punch hacia adelante
      parts.armR.rotation.x = -swing + (punchAnim * REMOTE_PUNCH_ANGLE);
      if (t >= 1) entry.punchTimer = -1;
    } else {
      parts.armR.rotation.x = swing;
    }
  }
}