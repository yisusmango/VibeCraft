// ═══════════════════════════════════════════════════════════════
//  src/player.js
//  Responsabilidades:
//    • Estado del jugador (position, velocity, isOnGround)
//    • Captura de teclado (WASD + Espacio)
//    • Detección de colisiones AABB contra el mundo
//    • Bucle de física: gravedad, movimiento y resolución por eje
//    • Sincronización cámara → posición del jugador
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { CONFIG, HALF_W } from './config.js';
import { hasBlock } from './world.js';

// ═══════════════════════════════════════════════════════════════
//  🧍  ESTADO DEL JUGADOR
// ═══════════════════════════════════════════════════════════════

/**
 * Objeto de estado mutable del jugador.
 * Exportado para que interaction.js y ui.js puedan leerlo.
 *
 *  position   — Coordenadas de los PIES (no de los ojos).
 *  velocity   — Velocidad actual en los tres ejes (bloques/seg).
 *  isOnGround — true si el jugador está apoyado sobre un bloque.
 */
export const player = {
  position   : new THREE.Vector3(15.5, 2.0, 15.5),
  velocity   : new THREE.Vector3(0, 0, 0),
  isOnGround : false,
};

// ═══════════════════════════════════════════════════════════════
//  🕹️  TECLADO
// ═══════════════════════════════════════════════════════════════

/** Estado binario de las teclas de movimiento. */
const keys = { w: false, a: false, s: false, d: false };

/**
 * Registra los listeners de teclado.
 * controls.getObject() es el padre de la cámara; necesitamos
 * referencia a controls para la comprobación isOnGround en Space.
 *
 * Nota: los listeners se añaden a document y permanecen activos
 * durante toda la sesión (un juego de ventana única no necesita
 * deregistrarlos).
 */
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    switch (e.code) {
      case 'KeyW':  keys.w = true; break;
      case 'KeyA':  keys.a = true; break;
      case 'KeyS':  keys.s = true; break;
      case 'KeyD':  keys.d = true; break;
      case 'Space':
        e.preventDefault();
        // Saltar solo si está en el suelo (evita doble-salto)
        if (player.isOnGround) {
          player.velocity.y = CONFIG.JUMP_FORCE;
          player.isOnGround = false;
        }
        break;
    }
  });

  document.addEventListener('keyup', (e) => {
    switch (e.code) {
      case 'KeyW': keys.w = false; break;
      case 'KeyA': keys.a = false; break;
      case 'KeyS': keys.s = false; break;
      case 'KeyD': keys.d = false; break;
    }
  });
}

// ═══════════════════════════════════════════════════════════════
//  💥  DETECCIÓN DE COLISIONES — AABB
//  ─────────────────────────────────────────────────────────────
//  PRINCIPIO MATEMÁTICO (Separating Axis Theorem simplificado):
//
//  Dos AABB se solapan si y solo si se solapan en los TRES ejes.
//  En cada eje, solapan si:  A_max > B_min  AND  A_min < B_max
//
//  AABB del jugador (origen = pies en pos.y):
//    X: [ pos.x − HALF_W,  pos.x + HALF_W ]  = [px−0.3, px+0.3]
//    Y: [ pos.y,           pos.y + HEIGHT  ]  = [py,     py+1.8]
//    Z: [ pos.z − HALF_W,  pos.z + HALF_W ]  = [pz−0.3, pz+0.3]
//
//  AABB de un bloque centrado en (bx, by, bz):
//    X: [ bx − 0.5,  bx + 0.5 ]
//    Y: [ by − 0.5,  by + 0.5 ]
//    Z: [ bz − 0.5,  bz + 0.5 ]
// ═══════════════════════════════════════════════════════════════

/**
 * Comprueba si la posición hipotética `pos` colisiona con algún bloque
 * del mundo usando el AABB del jugador.
 * @param {THREE.Vector3} pos — Posición candidata de los pies
 * @returns {boolean}
 */
export function checkBlockCollision(pos) {
  const pMinX = pos.x - HALF_W,  pMaxX = pos.x + HALF_W;
  const pMinY = pos.y,            pMaxY = pos.y + CONFIG.PLAYER_HEIGHT;
  const pMinZ = pos.z - HALF_W,  pMaxZ = pos.z + HALF_W;

  // Rango conservador de bloques que podrían solapar (solo se itera el vecindario local)
  const x0 = Math.floor(pMinX), x1 = Math.ceil(pMaxX);
  const y0 = Math.floor(pMinY), y1 = Math.ceil(pMaxY);
  const z0 = Math.floor(pMinZ), z1 = Math.ceil(pMaxZ);

  for (let bx = x0; bx <= x1; bx++) {
    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        if (!hasBlock(bx, by, bz)) continue;

        // Test SAT: los tres ejes deben solapar simultáneamente
        if (
          pMaxX > bx - 0.5 && pMinX < bx + 0.5 &&  // eje X
          pMaxY > by - 0.5 && pMinY < by + 0.5 &&  // eje Y
          pMaxZ > bz - 0.5 && pMinZ < bz + 0.5     // eje Z
        ) return true;
      }
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
//  🔄  FÍSICA Y MOVIMIENTO
//  ─────────────────────────────────────────────────────────────
//  ALGORITMO — Resolución por eje (sweep AABB simplificado):
//
//  Para cada eje de forma INDEPENDIENTE:
//    1. pos_candidata = pos_actual + velocidad × dt
//    2. ¿colisión en esa candidata? → No: mover  /  Sí: anular vel
//
//  Resolver ejes por separado evita que el jugador se quede
//  pegado en aristas o esquinas entre dos bloques adyacentes.
// ═══════════════════════════════════════════════════════════════

// Vectores temporales reutilizables — evita crear new Vector3 cada frame
const _fwd   = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up    = new THREE.Vector3(0, 1, 0);
const _test  = new THREE.Vector3();

/**
 * Aplica un tick de física al jugador.
 * @param {number}      dt       — Delta time en segundos
 * @param {THREE.Camera} camera  — Cámara (para leer su dirección de vista)
 * @param {object}       controls — PointerLockControls (para sincronizar posición)
 */
export function updatePhysics(dt, camera, controls) {
  // 1. ── GRAVEDAD: integración de Euler  →  v = v₀ + a·t
  player.velocity.y += CONFIG.GRAVITY * dt;

  // 2. ── DIRECCIÓN DE MOVIMIENTO (derivada de la orientación de la cámara)
  camera.getWorldDirection(_fwd);
  _fwd.y = 0;           // Proyectar al plano XZ (el jugador no "vuela" al mirar arriba)
  _fwd.normalize();
  _right.crossVectors(_fwd, _up).normalize();  // Vector derecho ortogonal a forward

  // Acumular componentes de movimiento según teclas activas
  let mx = 0, mz = 0;
  if (keys.w) { mx += _fwd.x;   mz += _fwd.z;   }
  if (keys.s) { mx -= _fwd.x;   mz -= _fwd.z;   }
  if (keys.a) { mx -= _right.x; mz -= _right.z; }
  if (keys.d) { mx += _right.x; mz += _right.z; }

  // Normalizar movimiento diagonal: sin esto la velocidad en diagonal sería √2 × SPEED
  const horizLen = Math.hypot(mx, mz);
  if (horizLen > 0) {
    mx = (mx / horizLen) * CONFIG.MOVE_SPEED;
    mz = (mz / horizLen) * CONFIG.MOVE_SPEED;
  }
  player.velocity.x = mx;
  player.velocity.z = mz;

  // 3. ── RESOLUCIÓN DE COLISIONES EJE A EJE

  player.isOnGround = false;  // Reset: se reestablece si hay colisión en Y bajando

  // ── Eje X ──────────────────────────────────────────────────
  _test.copy(player.position);
  _test.x += player.velocity.x * dt;
  if (!checkBlockCollision(_test)) {
    player.position.x = _test.x;
  } else {
    player.velocity.x = 0;
  }

  // ── Eje Y (gravedad / salto) ────────────────────────────────
  _test.copy(player.position);
  _test.y += player.velocity.y * dt;
  if (!checkBlockCollision(_test)) {
    player.position.y = _test.y;
  } else {
    if (player.velocity.y < 0) player.isOnGround = true;  // cayendo → aterrizó
    player.velocity.y = 0;
  }

  // ── Eje Z ──────────────────────────────────────────────────
  _test.copy(player.position);
  _test.z += player.velocity.z * dt;
  if (!checkBlockCollision(_test)) {
    player.position.z = _test.z;
  } else {
    player.velocity.z = 0;
  }

  // 4. ── BARRERA DE SEGURIDAD — respawn si cae fuera del mundo
  if (player.position.y < -20) {
    player.position.set(CONFIG.WORLD_SIZE / 2, 3, CONFIG.WORLD_SIZE / 2);
    player.velocity.set(0, 0, 0);
  }

  // 5. ── SINCRONIZAR CÁMARA: ojos = pies + EYE_HEIGHT
  controls.getObject().position.set(
    player.position.x,
    player.position.y + CONFIG.EYE_HEIGHT,
    player.position.z
  );
}

// ═══════════════════════════════════════════════════════════════
//  🚀  INICIALIZACIÓN
// ═══════════════════════════════════════════════════════════════

/**
 * Inicializa el módulo de jugador:
 *   - Registra listeners de teclado
 *   - Coloca la cámara en la posición inicial del jugador
 *
 * @param {object} controls — PointerLockControls
 */
export function initPlayer(controls) {
  initKeyboard();

  // Colocar la cámara sobre el jugador desde el primer frame
  controls.getObject().position.set(
    player.position.x,
    player.position.y + CONFIG.EYE_HEIGHT,
    player.position.z
  );
}