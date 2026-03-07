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
scene.fog        = new THREE.Fog(0x87CEEB, 40, 90);  // niebla para dar profundidad

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
//  🔧  INICIALIZACIÓN DE MÓDULOS
// ═══════════════════════════════════════════════════════════════

initWorld(scene);
generateWorld();

initPlayer(controls);
initInteraction(scene, controls);
initUI(controls);

// ── [NUEVO] ── Crear el sistema de entorno, pasando escena y luces
//  IMPORTANTE: llamar DESPUÉS de initWorld() para que scene.background
//  y scene.fog ya estén configurados (Environment los sobreescribirá
//  frame a frame, pero necesita que existan).
const environment = new Environment(scene, ambientLight, sunLight);

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

  updatePhysics(dt, camera, controls);
  updateRaycaster(camera, controls);
  updateHUD(player, blockMap, getTargetBlock());

  // ── [NUEVO] ── Actualizar ciclo día/noche, cuerpos celestes y nubes
  //  Se pasa `camera` para que el pivote del sol/luna siga al jugador.
  environment.update(dt, camera);

  renderer.render(scene, camera);
}

animate();