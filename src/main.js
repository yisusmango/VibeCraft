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
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

import { CONFIG }                           from './config.js';
import { initWorld, generateWorld, blockMap } from './world.js';
import { initPlayer, updatePhysics, player } from './player.js';
import { initInteraction, updateRaycaster, getTargetBlock } from './interaction.js';
import { initUI, updateHUD }                from './ui.js';
// ── [NUEVO] ── Importar el módulo de atmósfera ─────────────────
import { Environment }                      from './environment.js';

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
scene.fog        = new THREE.Fog(0x87CEEB, 60, 120);
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
generateWorld();

initPlayer(controls);
initInteraction(scene, controls);
initUI(controls);

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
// ═══════════════════════════════════════════════════════════════
//  🌍  GESTOR DE MUNDOS — referencias DOM
// ═══════════════════════════════════════════════════════════════
const elBtnCol     = document.querySelector('.mc-btn-col');
const elWorldMgr   = document.getElementById('world-manager');
const elWorldsList = document.getElementById('worlds-list');

// ── Función de lanzamiento de partida ───────────────────────────
//  Encapsula la lógica que antes estaba inline en btn-singleplayer.
//  Se llama desde el botón "Jugar" de cada .world-item, pasando el
//  nombre del mundo (para futura integración con IndexedDB).
function launchWorld(worldName) {
  console.info(`[VibeCraft] Cargando mundo: "${worldName}"`);
  isMenuVisible = false;
  document.body.classList.remove('menu-active');
  controls.getObject().rotation.set(0, 0, 0);
  camera.rotation.set(0, 0, 0);
  controls.lock();
}

// ── Mock data — inyecta mundos de prueba en #worlds-list ─────────
//  TODO (Fase siguiente): sustituir por lectura real desde IndexedDB.
//  Cada entrada usa la clase .world-item con info a la izquierda y
//  botones de acción a la derecha.
function renderMockWorlds() {
  const mockWorlds = [
    { name: 'Mi Rancho',         date: '08/03/2026', size: '128 KB' },
    { name: 'Mundo de Pruebas',  date: '07/03/2026', size: '64 KB'  },
  ];

  elWorldsList.innerHTML = mockWorlds.map(w => `
    <div class="world-item">
      <div class="world-item__info">
        <span class="world-item__name">${w.name}</span>
        <span class="world-item__meta">${w.date} &nbsp;·&nbsp; ${w.size}</span>
      </div>
      <div class="world-item__actions">
        <button class="mc-btn mc-btn--sm btn-play"   data-world="${w.name}">Jugar</button>
        <button class="mc-btn mc-btn--sm mc-btn--disabled" disabled>Exportar</button>
        <button class="mc-btn mc-btn--sm mc-btn--danger btn-delete" data-world="${w.name}">Borrar</button>
      </div>
    </div>
  `).join('');

  // Event delegation: un solo listener en la lista captura todos los clics
  elWorldsList.addEventListener('click', (e) => {
    const playBtn   = e.target.closest('.btn-play');
    const deleteBtn = e.target.closest('.btn-delete');

    if (playBtn)   launchWorld(playBtn.dataset.world);
    if (deleteBtn) {
      // TODO: confirmar + eliminar de IndexedDB
      const item = deleteBtn.closest('.world-item');
      item.style.opacity = '0.4';
      item.style.pointerEvents = 'none';
      console.info(`[VibeCraft] (Mock) Borrar mundo: "${deleteBtn.dataset.world}"`);
    }
  }, { once: false });
}

// ── btn-singleplayer: abre el gestor en lugar de entrar al juego ──
//  FLUJO:
//    1. Oculta .mc-btn-col (los tres botones del menú principal)
//    2. Muestra #world-manager con la lista de mundos
//    3. Rellena la lista con mock data (llamada idempotente)
document.getElementById('btn-singleplayer').addEventListener('click', () => {
  elBtnCol.style.display   = 'none';
  elWorldMgr.style.display = 'flex';
  renderMockWorlds();
});

// ── btn-world-back: vuelve al menú principal ──────────────────────
document.getElementById('btn-world-back').addEventListener('click', () => {
  elWorldMgr.style.display = 'none';
  elBtnCol.style.display   = 'flex';
});

// ── btn-world-new: placeholder (Fase siguiente = generador de mundo) ─
document.getElementById('btn-world-new').addEventListener('click', () => {
  // TODO: abrir panel de creación de mundo con nombre + seed
  console.info('[VibeCraft] Crear Nuevo Mundo — pendiente de implementar');
});

// ── [NUEVO] ── Crear el sistema de entorno, pasando escena y luces
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
    const phase = KEY_PHASE_MAP[e.code];
    if (!phase) return;
    e.preventDefault();                          // evita scroll u otros defaults
    environment.setTime(phase);
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
    updatePhysics(dt, camera, controls);
    updateRaycaster(camera, controls);
    updateHUD(player, blockMap, getTargetBlock());
  }

  // Environment se actualiza siempre (día/noche visible en el menú también)
  environment.update(dt, camera);

  renderer.render(scene, camera);
}

animate();