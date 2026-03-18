// ═══════════════════════════════════════════════════════════════
//  src/main.js  —  Punto de entrada de VibeCraft
//  ─────────────────────────────────────────────────────────────
//  Responsabilidades EXCLUSIVAS de este archivo:
//    1. Crear y configurar Renderer, Scene y Camera
//    2. Configurar la iluminación (AmbientLight + DirectionalLight)
//    3. Inicializar PointerLockControls
//    4. Orquestar la inicialización de todos los módulos
//    5. Gestionar el resize de ventana
//    6. Ejecutar el bucle de animación principal (requestAnimationFrame)
//
//  NO contiene lógica de juego. Cada sistema vive en su módulo.
//
//  CAMBIOS v0.3.2:
//    • Import de updateParticles desde particles.js
//    • Llamada a updateParticles(dt, scene) en el bucle animate()
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

import { CONFIG }                           from './config.js';
import { initWorld, updateChunks, resetChunks, blockMap, hasBlock,
         serializeWorld, deserializeWorld,
         checkLeafDecay, updateFluids }      from './world.js';
import { initPlayer, updatePhysics, player } from './player.js';
import { initInteraction, updateRaycaster, getTargetBlock } from './interaction.js';
import { initUI, updateHUD }                from './ui.js';
import { Environment }                      from './environment.js';
import { getAllWorlds, saveWorld,
         loadWorld,   deleteWorld }         from './storage.js';
import { initMultiplayer, sendUpdate,
         updateOtherPlayers,
         sendAdminTimeUpdate }              from './multiplayer.js';
import { initAudio, resumeAudio }           from './audio.js';
import { updateParticles }                  from './particles.js';

// ═══════════════════════════════════════════════════════════════
//  🖥️  RENDERER
// ═══════════════════════════════════════════════════════════════

const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// ═══════════════════════════════════════════════════════════════
//  🎬  ESCENA
// ═══════════════════════════════════════════════════════════════

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87CEEB);        // azul cielo
const drawDistance = CONFIG.RENDER_DISTANCE * CONFIG.CHUNK_SIZE;
// Niebla dinámica con límite inferior absoluto:
// fogNear mínimo 62 → la niebla nunca alcanza las nubes del cénit (Y=60)
// independientemente de cuán pequeño sea RENDER_DISTANCE.
const fogNear = Math.max(drawDistance * 0.4, 62);
scene.fog        = new THREE.Fog(0x87CEEB, fogNear, drawDistance - 4);
// ── Calibración niebla + nubes ───────────────────────────────────
//  CLOUD_Y=60, cámara en y≈3 → distancia vertical a la capa = ~57 u.
//
//  Con near=60 / far=120:
//    • Nubes en vertical (dist ≈57 u)   → 0 % niebla  — completamente visibles
//    • Nubes a 45° (dist ≈83 u)         → 38% niebla  — desvanecimiento suave
//    • Nubes en horizonte (dist ≈115 u) → 92% niebla  — casi invisibles
//    • Borde del grid (dist ≈1025 u)    → 100% niebla — completamente oculto
//
//  El terreno conserva un horizonte neblinoso natural (empieza a los 60 u
//  en lugar de 40 u anteriores, ganando algo más de profundidad de campo).

// ═══════════════════════════════════════════════════════════════
//  📷  CÁMARA EN PRIMERA PERSONA
// ═══════════════════════════════════════════════════════════════

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.05,
  200
);

// ═══════════════════════════════════════════════════════════════
//  💡  ILUMINACIÓN
// ═══════════════════════════════════════════════════════════════

// [SIN CAMBIOS] — Environment tomará el control de color e intensidad en tiempo real.
const ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambientLight);

const sunLight = new THREE.DirectionalLight(0xfffbe0, 0.85);
sunLight.position.set(30, 60, 20);
sunLight.castShadow                = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.near        = 0.5;
sunLight.shadow.camera.far         = 200;
sunLight.shadow.camera.left        = -50;
sunLight.shadow.camera.right       =  50;
sunLight.shadow.camera.top         =  50;
sunLight.shadow.camera.bottom      = -50;
sunLight.shadow.bias               = -0.001;
scene.add(sunLight);
scene.add(sunLight.target);  // target debe estar en escena para posicionarse dinámicamente

// ═══════════════════════════════════════════════════════════════
//  🎮  POINTER LOCK CONTROLS
// ═══════════════════════════════════════════════════════════════

const controls = new PointerLockControls(camera, renderer.domElement);
scene.add(controls.getObject());

// ═══════════════════════════════════════════════════════════════
//  🎮  ESTADO DE JUEGO — MENÚ vs JUGANDO
//  ─────────────────────────────────────────────────────────────
//  isMenuVisible = true   → menú principal activo
//    • Física pausada          • Solo el panorama gira la cámara
//    • Raycaster inactivo      • Environment se actualiza (día/noche)
//  isMenuVisible = false  → jugador en control
//    • Todo el pipeline normal
// ═══════════════════════════════════════════════════════════════
let isMenuVisible = true;

// ── Configuración del panorama de fondo ──────────────────────────
//  La cámara orbita alrededor del centro del mundo (WORLD_SIZE/2)
//  a baja velocidad, replicando el panorama clásico de Minecraft.
//
//  PANO_SPEED: 0.025 rad/s → vuelta completa en ≈251 seg (≈4 min)
//  PANO_RADIUS: 14 bloques → suficiente para ver el terreno sin
//               salir de los 32×32 del mundo generado.
//  PANO_HEIGHT: 4 unidades → cámara por encima del suelo (Y=0.5)
//               apuntando ligeramente hacia abajo para ver el terreno.
const PANO_CENTER = new THREE.Vector3(16, 4, 16);
const PANO_RADIUS = 14;
const PANO_SPEED  = 0.025;  // radianes/seg
const PANO_PITCH  = -0.10;  // inclinación de cámara (negativo = mirar abajo)
let   panoramaAngle = 0;

// ═══════════════════════════════════════════════════════════════
//  🔧  INICIALIZACIÓN DE MÓDULOS
// ═══════════════════════════════════════════════════════════════

initWorld(scene);
// generateDefaultWorld() ya no se llama aquí:
// cada mundo se carga/crea desde el Gestor de Mundos en los listeners de abajo.

initPlayer(controls, camera);
initInteraction(scene, controls);
initUI(controls);
// initMultiplayer() ya NO se llama aquí en el arranque.
// Se invoca bajo demanda en startMultiplayer() cuando el jugador elige Multijugador.

// ── Audio: debe inicializarse después de que la cámara exista ────
//  initAudio añade el AudioListener como hijo de la cámara, por lo que
//  la cámara ya debe estar creada (línea ~70 de este archivo).
//  Se coloca aquí, con el resto de inits, antes del bucle de animación.
initAudio(camera);

// ═══════════════════════════════════════════════════════════════
//  🏠  BOTÓN SINGLEPLAYER — transición Menú → Juego
//  ─────────────────────────────────────────────────────────────
//  Flujo al hacer clic:
//    1. isMenuVisible = false → el animate() activa la física
//    2. body.menu-active se elimina → CSS muestra el HUD
//    3. controls.lock() → PointerLock activo, jugador en control
//
//  controls.lock() requiere un gesto de usuario (clic de ratón).
//  Como el listener es mousedown/click en un botón, el navegador
//  lo acepta como gesto válido.
// ═══════════════════════════════════════════════════════════════
//  🌍  GESTOR DE MUNDOS — referencias DOM y estado
// ═══════════════════════════════════════════════════════════════
const elBtnCol     = document.querySelector('.mc-btn-col');
const elWorldMgr   = document.getElementById('world-manager');
const elWorldsList = document.getElementById('worlds-list');

// ── Estado global de la partida activa ──────────────────────────
let currentWorldId   = null;
let currentWorldName = '';

// ── Lanzamiento de partida ───────────────────────────────────────
//  resumeAudio() DEBE ir antes de controls.lock() porque ambas
//  operaciones se producen dentro del mismo gesto de usuario (clic).
//  El navegador concede el permiso de AudioContext.resume() solo
//  mientras la pila de llamadas sigue siendo sincrónica respecto al
//  evento original. controls.lock() no consume el gesto, pero por
//  semántica y claridad mantenemos el audio primero.
function launchWorld() {
  isMenuVisible = false;
  document.body.classList.remove('menu-active');
  controls.getObject().rotation.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  resumeAudio();   // desbloquear AudioContext dentro del gesto de usuario
  controls.lock();
}

// ── Renderizado de la lista de mundos (IndexedDB) ─────────────────
async function renderWorldsList() {
  elWorldsList.innerHTML = '<p style="color:#888;font-size:.6rem;padding:12px;font-family:\'Courier New\',monospace;">Cargando mundos…</p>';
  const worlds = await getAllWorlds();

  if (worlds.length === 0) {
    elWorldsList.innerHTML = '<p style="color:#666;font-size:.6rem;padding:12px;font-family:\'Courier New\',monospace;">No hay mundos guardados. ¡Crea uno nuevo!</p>';
    return;
  }

  const fmt = iso => {
    const d = new Date(iso);
    const dd   = String(d.getDate()).padStart(2,'0');
    const mm   = String(d.getMonth()+1).padStart(2,'0');
    const yyyy = d.getFullYear();
    const hh   = String(d.getHours()).padStart(2,'0');
    const min  = String(d.getMinutes()).padStart(2,'0');
    return `${dd}/${mm}/${yyyy} ${hh}:${min}`;
  };

  elWorldsList.innerHTML = worlds.map(w => `
    <div class="world-item" data-id="${w.id}">
      <div class="world-item__info">
        <span class="world-item__name">${w.name}</span>
        <span class="world-item__meta">${fmt(w.lastPlayed)} &nbsp;·&nbsp; ${w.blocks.length} bloques</span>
      </div>
      <div class="world-item__actions">
        <button class="mc-btn mc-btn--sm btn-play"    data-id="${w.id}" data-name="${w.name}">Jugar</button>
        <button class="mc-btn mc-btn--sm btn-export"  data-id="${w.id}" data-name="${w.name}">Exportar</button>
        <button class="mc-btn mc-btn--sm mc-btn--danger btn-delete" data-id="${w.id}">Borrar</button>
      </div>
    </div>
  `).join('');

  elWorldsList.addEventListener('click', async (e) => {
    const playBtn   = e.target.closest('.btn-play');
    const exportBtn = e.target.closest('.btn-export');
    const deleteBtn = e.target.closest('.btn-delete');

    if (playBtn) {
      const id = Number(playBtn.dataset.id);
      currentWorldId   = id;
      currentWorldName = playBtn.dataset.name;
      try {
        const data = await loadWorld(id);
        deserializeWorld(data.blocks ?? []);
        spawnPlayerSafe();
        await saveWorld(id, currentWorldName, data.blocks ?? []);
      } catch (err) {
        console.error('[VibeCraft] Error al cargar mundo:', err);
        return;
      }
      launchWorld();
    }

    // ── Exportar → descarga [nombre].vibecraft ───────────────────
    //  FLUJO:
    //   1. loadWorld() lee el objeto completo (id, name, blocks, lastPlayed)
    //   2. JSON.stringify → texto plano legible
    //   3. Blob (application/json) + createObjectURL → URL temporal en memoria
    //   4. <a download> invisible → el navegador inicia la descarga del archivo
    //   5. revokeObjectURL() → libera la memoria del Blob inmediatamente
    //      (el navegador ya ha encolado la descarga antes de la revocación)
    if (exportBtn) {
      const id   = Number(exportBtn.dataset.id);
      const name = exportBtn.dataset.name;
      try {
        const data = await loadWorld(id);
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href     = url;
        a.download = `${name}.vibecraft`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('[VibeCraft] Error al exportar mundo:', err);
      }
    }

    if (deleteBtn) {
      const id = Number(deleteBtn.dataset.id);
      const item = deleteBtn.closest('.world-item');
      item.style.opacity       = '0.4';
      item.style.pointerEvents = 'none';
      try {
        await deleteWorld(id);
        await renderWorldsList();
      } catch (err) {
        console.error('[VibeCraft] Error al borrar mundo:', err);
        item.style.opacity       = '';
        item.style.pointerEvents = '';
      }
    }
  });
}


// ── Spawn seguro: coloca al jugador sobre el terreno ─────────────
//  Busca desde y=32 hacia abajo el primer bloque sólido en el centro
//  del mundo, y coloca al jugador 2 unidades por encima para que
//  caiga suavemente sobre la superficie en lugar de aparecer bajo tierra.
function spawnPlayerSafe() {
  // Busca terreno en las coordenadas XZ actuales del jugador.
  // Para mundos nuevos: player.position ya apunta al centro del
  // chunk de spawn antes de llamar a esta función.
  const sx = Math.floor(player.position.x);
  const sz = Math.floor(player.position.z);
  let y = 64;
  while (y > 0 && !hasBlock(sx, y, sz)) y--;
  player.position.set(sx + 0.5, y + 2.0, sz + 0.5);
  player.velocity.set(0, 0, 0);
}

// ── btn-singleplayer ──────────────────────────────────────────────
document.getElementById('btn-singleplayer').addEventListener('click', () => {
  elBtnCol.style.display   = 'none';
  elWorldMgr.style.display = 'flex';
  document.body.classList.add('wm-active');
  renderWorldsList();
});

// ── btn-world-back ────────────────────────────────────────────────
document.getElementById('btn-world-back').addEventListener('click', () => {
  elWorldMgr.style.display = 'none';
  elBtnCol.style.display   = 'flex';
  document.body.classList.remove('wm-active');
});

// ── btn-world-import: importar archivo .vibecraft desde disco ─────
//  El botón está deshabilitado en el HTML; lo habilitamos aquí en JS
//  para mantener index.html libre de lógica de estado.
//
//  FLUJO:
//   1. Creamos un <input type="file"> invisible y lo activamos con .click().
//      El navegador acepta esto como gesto de usuario (event listener de botón).
//   2. FileReader.readAsText() lee el contenido del archivo seleccionado.
//   3. JSON.parse() reconstruye el objeto; validamos campos mínimos.
//   4. Nuevo id con Date.now() → evita colisiones aunque el archivo tenga
//      el mismo id que un mundo existente en esta instalación.
//   5. saveWorld() persiste en IndexedDB y renderWorldsList() refresca la UI.
(function () {
  const btn = document.getElementById('btn-world-import');
  btn.disabled  = false;
  btn.classList.remove('mc-btn--disabled');

  btn.addEventListener('click', () => {
    const input  = document.createElement('input');
    input.type   = 'file';
    input.accept = '.vibecraft';

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target.result);

          // Validación mínima: necesitamos nombre y array de bloques
          if (typeof data.name !== 'string' || !Array.isArray(data.blocks)) {
            alert('Archivo .vibecraft inválido: faltan los campos "name" o "blocks".');
            return;
          }

          const newId = Date.now();   // id fresco → nunca pisa un mundo local
          await saveWorld(newId, data.name, data.blocks);
          console.info(`[VibeCraft] Mundo "${data.name}" importado (${data.blocks.length} bloques).`);

          // Mostrar el gestor con la lista actualizada
          elBtnCol.style.display   = 'none';
          elWorldMgr.style.display = 'flex';
          document.body.classList.add('wm-active');
          await renderWorldsList();

        } catch (err) {
          console.error('[VibeCraft] Error al importar .vibecraft:', err);
          alert('No se pudo leer el archivo. Asegúrate de que es un .vibecraft válido.');
        }
      };

      reader.readAsText(file);
    });

    input.click();   // abre el selector de archivos del SO
  });
})();

// ── btn-world-new ─────────────────────────────────────────────────
document.getElementById('btn-world-new').addEventListener('click', async () => {
  const raw  = prompt('Introduce el nombre para tu nuevo mundo:');
  const name = raw ? raw.trim() : '';
  if (!name) return;

  const id = Date.now();
  currentWorldId   = id;
  currentWorldName = name;

  // Posicionar al jugador en el centro del chunk de spawn (0,0)
  // ANTES de generar terreno, para que updateChunks sepa qué chunks cargar
  // y spawnPlayerSafe pueda buscar suelo en esas coordenadas.
  player.position.set(
    CONFIG.CHUNK_SIZE / 2 + 0.5,
    64,
    CONFIG.CHUNK_SIZE / 2 + 0.5,
  );
  player.velocity.set(0, 0, 0);

  deserializeWorld([]);
  setNoiseSeed(Math.random());
  resetChunks();
  updateChunks(player.position.x, player.position.z);
  spawnPlayerSafe();

  try {
    await saveWorld(id, name, serializeWorld());
  } catch (err) {
    console.error('[VibeCraft] Error al guardar mundo nuevo:', err);
  }
  launchWorld();
});

// ── btn-quit ──────────────────────────────────────────────────────
document.getElementById('btn-quit').addEventListener('click', async () => {
  if (currentWorldId !== null) {
    try {
      await saveWorld(currentWorldId, currentWorldName, serializeWorld());
      console.info(`[VibeCraft] Mundo "${currentWorldName}" guardado.`);
    } catch (err) {
      console.error('[VibeCraft] Error al guardar en btn-quit:', err);
    }
  }
  // Desactivar la sincronización de tiempo con el servidor al volver al menú.
  // En singleplayer el reloj debe volver a avanzar localmente en update().
  environment.isServerSynced = false;
  document.getElementById('overlay').style.display = 'none';
  document.body.classList.add('menu-active');
  isMenuVisible = true;
});

// ═══════════════════════════════════════════════════════════════
//  🌐  FLUJO MULTIJUGADOR
//  ─────────────────────────────────────────────────────────────
//  startMultiplayer() ESPERA a que initMultiplayer() resuelva su
//  Promise (= servidor envió SERVER_SEED) antes de generar chunks.
//  Esto elimina la condición de carrera donde el terreno se generaba
//  con Math.random() local en lugar de la semilla compartida.
// ═══════════════════════════════════════════════════════════════

async function startMultiplayer() {
  // Mostrar feedback mientras se conecta
  const btn = document.getElementById('btn-multiplayer');
  const originalText = btn.textContent;
  btn.textContent  = 'Conectando…';
  btn.disabled     = true;

  try {
    // AWAIT: bloquea hasta recibir SERVER_SEED — sin carrera posible.
    // Pasamos `environment` para que multiplayer.js pueda inyectar dayT
    // desde worldInit (sincronización inicial del reloj día/noche).
    await initMultiplayer(scene, environment);

    // El servidor ha enviado su dayT canónico vía worldInit (ya aplicado
    // por setDayT() dentro de multiplayer.js). Activamos isServerSynced
    // para que update() deje de avanzar _dayT localmente — el reloj lo
    // controla ahora el servidor (y las correcciones periódicas timeUpdate).
    environment.isServerSynced = true;

    // Semilla ya inyectada en world.js; ahora es seguro generar terreno
    currentWorldId   = null;   // multijugador no usa IndexedDB local
    currentWorldName = 'Multiplayer';

    player.position.set(
      CONFIG.CHUNK_SIZE / 2 + 0.5,
      64,
      CONFIG.CHUNK_SIZE / 2 + 0.5,
    );
    player.velocity.set(0, 0, 0);

    deserializeWorld([]);
    resetChunks();   // usa la semilla ya establecida por setNoiseSeed()
    updateChunks(player.position.x, player.position.z);
    spawnPlayerSafe();
    launchWorld();

  } catch (err) {
    console.error('[VibeCraft] Error de conexión multijugador:', err);
    alert('No se pudo conectar al servidor.\nAsegúrate de que server.js está corriendo en localhost:3000.');
    btn.textContent = originalText;
    btn.disabled    = false;
  }
}

document.getElementById('btn-multiplayer').addEventListener('click', () => {
  startMultiplayer();
});

//  IMPORTANTE: llamar DESPUÉS de initWorld() para que scene.background
//  y scene.fog ya estén configurados (Environment los sobreescribirá
//  frame a frame, pero necesita que existan).
const environment = new Environment(scene, ambientLight, sunLight);

// ── [NUEVO] ── Dev Tools: botones de control de tiempo ──────────
//  Los botones están en el DOM (#dev-tools) y son accesibles incluso
//  sin Pointer Lock. Delegamos en un único listener en el contenedor
//  padre (event delegation) para evitar 4 addEventListener separados.
//
//  Flujo: click en .dev-btn → lee data-phase → llama setTime() en
//  environment → marca el botón activo visualmente.
{
  const devPanel   = document.getElementById('dev-tools');
  const devButtons = devPanel.querySelectorAll('.dev-btn');

  function setActiveBtn(phase) {
    devButtons.forEach(b => b.classList.toggle('active', b.dataset.phase === phase));
  }

  // ── CLICK con stopPropagation ─────────────────────────────────
  //  Sin stopPropagation, el clic burbujea hasta document → llega al
  //  listener del #overlay → controls.lock() intenta reactivar el
  //  Pointer Lock justo cuando el usuario quería pulsar un botón.
  //  stopPropagation corta la cadena en el panel y el overlay nunca
  //  lo ve.
  devPanel.addEventListener('click', (e) => {
    e.stopPropagation();                         // ← NUEVO: evita reactivar PointerLock
    const btn = e.target.closest('.dev-btn');
    if (!btn) return;
    const phase = btn.dataset.phase;
    environment.setTime(phase);
    // En multijugador, propagar el cambio de hora al servidor para que
    // todos los demás clientes se sincronicen al nuevo tiempo inmediatamente.
    if (environment.isServerSynced) sendAdminTimeUpdate(environment.dayT);
    setActiveBtn(phase);
  });

  // ── ATAJOS DE TECLADO: U / I / O / P ─────────────────────────
  //  Permiten cambiar la hora sin ratón, útil mientras el Pointer Lock
  //  está activo (cursor oculto) o en pausa.
  //
  //  Mapa de teclas elegido para no solapar con WASD ni Espacio:
  //    U → Dawn     (alba)
  //    I → Noon     (mediodía)   ← "I" de Illuminated / noon
  //    O → Dusk     (atardecer)
  //    P → Midnight (noche)      ← "P" de oscuridaD → noche
  //
  //  e.code (posición física) en lugar de e.key (carácter) para
  //  funcionar independientemente del idioma del teclado del usuario.
  const KEY_PHASE_MAP = {
    KeyU: 'dawn',
    KeyI: 'noon',
    KeyO: 'dusk',
    KeyP: 'midnight',
  };

  document.addEventListener('keydown', (e) => {
    if (isMenuVisible) return;
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    const phase = KEY_PHASE_MAP[e.code];
    if (!phase) return;
    e.preventDefault();                          // evita scroll u otros defaults
    environment.setTime(phase);
    // En multijugador, propagar el cambio de hora al servidor para que
    // todos los demás clientes se sincronicen al nuevo tiempo inmediatamente.
    if (environment.isServerSynced) sendAdminTimeUpdate(environment.dayT);
    setActiveBtn(phase);
  });

  // Marcar "alba" como activa al arrancar (dayT inicial = 0.0 = dawn)
  setActiveBtn('dawn');
}

// ═══════════════════════════════════════════════════════════════
//  📐  RESIZE
// ═══════════════════════════════════════════════════════════════

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ═══════════════════════════════════════════════════════════════
//  ▶️  BUCLE DE ANIMACIÓN PRINCIPAL
// ═══════════════════════════════════════════════════════════════

const clock = new THREE.Clock();
let waterTimer = 0;

function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(clock.getDelta(), 0.05);

  if (isMenuVisible) {
    // ── MODO MENÚ: panorama cinematográfico ──────────────────────
    //
    //  La cámara orbita alrededor de PANO_CENTER sin activar la física.
    //  Manipulamos el "yaw object" de PointerLockControls directamente
    //  (controls no están bloqueados, por lo que no interfieren):
    //
    //    controls.getObject()   → yaw   (rotación Y = izquierda/derecha)
    //    camera                 → pitch (rotación X = arriba/abajo)
    //
    //  Math.atan2(dx, dz) devuelve el ángulo que apunta hacia el centro
    //  en la convención de Three.js (Y-up, eje Z hacia la cámara).
    panoramaAngle += PANO_SPEED * dt;

    const px = PANO_CENTER.x + Math.cos(panoramaAngle) * PANO_RADIUS;
    const pz = PANO_CENTER.z + Math.sin(panoramaAngle) * PANO_RADIUS;

    const yawObj = controls.getObject();
    yawObj.position.set(px, PANO_CENTER.y, pz);
    yawObj.rotation.y = Math.atan2(PANO_CENTER.x - px, PANO_CENTER.z - pz);
    yawObj.rotation.z = 0;   // ← forzar: sin roll en el yaw object
    camera.rotation.x = PANO_PITCH;
    camera.rotation.z = 0;   // ← forzar: sin roll en la cámara hija

  } else {
    // ── MODO JUEGO: pipeline completo ───────────────────────────
    //  La física y el raycaster SOLO avanzan cuando el PointerLock
    //  está activo (cursor capturado = jugador en control).
    //  Si el menú de pausa está visible, controls.isLocked === false
    //  y el jugador no puede moverse ni interactuar, pero el HUD y
    //  el ciclo día/noche (environment.update, fuera de este bloque)
    //  siguen corriendo con normalidad.
    if (controls.isLocked) {
      updatePhysics(dt, camera, controls);
      updateChunks(player.position.x, player.position.z);
      updateRaycaster(camera, controls);
      sendUpdate(player.position, camera);  // multiplayer: enviar estado local
    }

    updateOtherPlayers();  // multiplayer: interpolar posiciones remotas
    updateHUD(player, blockMap, getTargetBlock());
    checkLeafDecay();

    // ── v0.3.2: tick de partículas ───────────────────────────────
    //  Se llama FUERA de controls.isLocked: las partículas en vuelo
    //  siguen simulándose aunque el jugador abra el menú de pausa
    //  (cursor desbloqueado). La gravedad y el lifespan continúan.
    updateParticles(dt, scene);

    waterTimer += dt;
    if (waterTimer >= 0.2) {
      waterTimer -= 0.2;
      updateFluids();
    }
  }

  // Environment se actualiza siempre (día/noche visible en el menú también)
  environment.update(dt, camera);

  renderer.render(scene, camera);
}

animate();