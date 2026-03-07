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
scene.fog        = new THREE.Fog(0x87CEEB, 40, 90);  // niebla para dar profundidad

// ═══════════════════════════════════════════════════════════════
//  📷  CÁMARA EN PRIMERA PERSONA
//  ─────────────────────────────────────────────────────────────
//  FOV 75° — valor estándar de Minecraft.
//  near 0.05 — evita z-fighting en bloques muy cercanos.
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

// Luz ambiente: ilumina uniformemente toda la escena sin proyectar sombras.
// Simula la luz difusa del cielo (rebote ambiental).
const ambientLight = new THREE.AmbientLight(0xffffff, 0.55);
scene.add(ambientLight);

// Luz solar: direccional con sombras suaves PCF.
// position define la dirección de los rayos (fuente en el "infinito").
const sunLight = new THREE.DirectionalLight(0xfffbe0, 0.85);
sunLight.position.set(30, 60, 20);
sunLight.castShadow                = true;
sunLight.shadow.mapSize.set(2048, 2048);  // mapa de sombras de alta res
sunLight.shadow.camera.near        = 0.5;
sunLight.shadow.camera.far         = 200;
sunLight.shadow.camera.left        = -50;
sunLight.shadow.camera.right       =  50;
sunLight.shadow.camera.top         =  50;
sunLight.shadow.camera.bottom      = -50;
sunLight.shadow.bias               = -0.001;  // elimina "shadow acne"
scene.add(sunLight);

// ═══════════════════════════════════════════════════════════════
//  🎮  POINTER LOCK CONTROLS
// ═══════════════════════════════════════════════════════════════

const controls = new PointerLockControls(camera, renderer.domElement);
// getObject() devuelve el pivot padre de la cámara (yaw object).
// Añadirlo a la escena hace que la cámara se renderice correctamente.
scene.add(controls.getObject());

// ═══════════════════════════════════════════════════════════════
//  🔧  INICIALIZACIÓN DE MÓDULOS
//  ─────────────────────────────────────────────────────────────
//  El orden importa:
//    1. initWorld   → inyecta la escena en world.js antes de crear bloques
//    2. generateWorld → puebla el blockMap (necesita la escena inyectada)
//    3. initPlayer  → registra teclado y coloca la cámara
//    4. initInteraction → añade el highlight a la escena y registra el ratón
//    5. initUI      → conecta el overlay con PointerLockControls
// ═══════════════════════════════════════════════════════════════

initWorld(scene);       // 1. world.js necesita la escena para scene.add(mesh)
generateWorld();        // 2. crear el terreno plano de CONFIG.WORLD_SIZE × WORLD_SIZE

initPlayer(controls);  // 3. teclado + posición inicial de la cámara
initInteraction(scene, controls);  // 4. highlight + eventos de ratón
initUI(controls);      // 5. overlay show/hide

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
//  ─────────────────────────────────────────────────────────────
//  Orden de operaciones por frame:
//    1. Calcular dt (limitado a 50 ms para evitar tunneling en
//       frames muy lentos o cuando la pestaña queda en segundo plano)
//    2. Física del jugador (movimiento + colisiones + cámara)
//    3. Raycasting (bloque apuntado + highlight)
//    4. HUD (actualizar DOM)
//    5. Render (WebGL)
// ═══════════════════════════════════════════════════════════════

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  // dt = tiempo desde el último frame en segundos
  // Clamping a 50 ms (20 fps mínimo) evita "saltos" físicos grandes
  const dt = Math.min(clock.getDelta(), 0.05);

  updatePhysics(dt, camera, controls);          // player.js
  updateRaycaster(camera, controls);            // interaction.js
  updateHUD(player, blockMap, getTargetBlock()); // ui.js

  renderer.render(scene, camera);
}

animate(); // 🚀  ¡Motor en marcha!