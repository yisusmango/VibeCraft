// ═══════════════════════════════════════════════════════════════
//  src/player.js
//  Responsabilidades:
//    • Estado del jugador (position, velocity, isOnGround)
//    • Captura de teclado (WASD + Espacio)
//    • Detección de colisiones AABB contra el mundo
//    • Bucle de física: gravedad, movimiento y resolución por eje
//    • Sincronización cámara → posición del jugador
//    • Sistema de sonido de pasos (stepAccumulator)
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { CONFIG, HALF_W } from './config.js';
import { hasBlock, getBlockType, MATERIALS } from './world.js';
import { playStepSound } from './audio.js';
import { createPlayerModel } from './SkinModel.js';
import { getSavedSkin, getCurrentBlockType } from './ui.js';

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
//  🦶  ACUMULADOR DE PASOS
//  ─────────────────────────────────────────────────────────────
//  stepAccumulator suma la distancia XZ recorrida en cada frame.
//  Cuando supera el umbral STEP_THRESHOLD (≈ longitud de un paso),
//  se reproduce un sonido de paso y el acumulador se reinicia.
//
//  Umbral de 1.8 unidades ≈ la cadencia visual del head bob,
//  que a BOB_SPEED=11 ciclos/seg produce un zancada cada ~0.57s
//  (velocidad de caminata real de Minecraft: ~4.3 bloques/seg,
//   paso efectivo cada ~1.3 bloques en velocidad de marcha normal).
// ═══════════════════════════════════════════════════════════════

/** Distancia XZ acumulada desde el último sonido de paso. */
let stepAccumulator = 0;

/** Umbral de distancia (bloques) para disparar un nuevo sonido de paso. */
const STEP_THRESHOLD = 1.8;

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
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
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
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
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

// ═══════════════════════════════════════════════════════════════
//  🧱  TIPOS NO SÓLIDOS — colisión física ignorada
//  ─────────────────────────────────────────────────────────────
//  Bloques cuya geometría es menor al cubo 1×1×1 estándar.
//  checkBlockCollision los omite para que el jugador pueda
//  caminar a través de ellos sin quedarse atascado.
//
//  Para añadir nuevos bloques no sólidos en el futuro (flores,
//  setas, etc.) basta con añadir su clave aquí.
// ═══════════════════════════════════════════════════════════════
const NON_SOLID_TYPES = new Set(['torch', 'water']);

/**
 * Comprueba si la posición hipotética `pos` colisiona con algún bloque
 * SÓLIDO del mundo usando el AABB del jugador.
 *
 * CAMBIO RESPECTO A LA VERSIÓN ANTERIOR:
 *   Antes: hasBlock() → cualquier bloque bloqueaba
 *   Ahora: hasBlock() + getBlockType() → NON_SOLID_TYPES se ignoran
 *
 * El coste extra es O(1) por bloque candidato (lookup en Set y en Map),
 * por lo que el impacto en el framerate es despreciable.
 *
 * @param {THREE.Vector3} pos — Posición candidata de los pies
 * @returns {boolean}
 */
export function checkBlockCollision(pos) {
  const pMinX = pos.x - HALF_W,  pMaxX = pos.x + HALF_W;
  const pMinY = pos.y,            pMaxY = pos.y + CONFIG.PLAYER_HEIGHT;
  const pMinZ = pos.z - HALF_W,  pMaxZ = pos.z + HALF_W;

  const x0 = Math.floor(pMinX), x1 = Math.ceil(pMaxX);
  const y0 = Math.floor(pMinY), y1 = Math.ceil(pMaxY);
  const z0 = Math.floor(pMinZ), z1 = Math.ceil(pMaxZ);

  for (let bx = x0; bx <= x1; bx++) {
    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        if (!hasBlock(bx, by, bz)) continue;

        // ── Saltar bloques no sólidos (antorchas, etc.) ──────────
        //   getBlockType() devuelve null si no hay bloque → hasBlock
        //   ya lo filtró arriba, así que aquí siempre retorna string.
        if (NON_SOLID_TYPES.has(getBlockType(bx, by, bz))) continue;

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

// ═══════════════════════════════════════════════════════════════
//  🎮  HEAD BOBBING
//  ─────────────────────────────────────────────────────────────
//  Parámetros de ajuste rápido:
//    BOB_SPEED     → frecuencia del ciclo de paso (ciclos/seg).
//                    Valor real Minecraft ~1.8 pasos/seg ≈ BOB_SPEED ≈ 11
//    BOB_AMPLITUDE → desplazamiento máximo en Y (bloques).
//                    Valores pequeños (0.04–0.08) se sienten naturales.
//    BOB_LERP      → velocidad de suavizado al detenerse (0-1 por seg).
//                    Más alto = vuelta más brusca a la altura base.
// ═══════════════════════════════════════════════════════════════
const BOB_SPEED     = 11.0;   // ciclos/seg mientras se camina
const BOB_AMPLITUDE = 0.055;  // desplazamiento máximo en Y (bloques)
const BOB_LERP      = 12.0;   // velocidad de interpolación al parar

let _bobAccum  = 0;  // acumulador de fase (radianes), avanza solo al caminar
let _bobOffset = 0;  // offset Y actual aplicado a la cámara (suavizado)

// ═══════════════════════════════════════════════════════════════
//  First-Person Arm
// ═══════════════════════════════════════════════════════════════

let _fpArm            = null;
let _camera           = null;
let _heldMesh         = null;
let _currentHeldType  = null;

// ── HOTFIX v0.3.1 — Estética Minecraft: posición y rotación de reposo ──
//  ARM_REST_POS: mano más alta (y: -0.25 vs -0.32) y más cercana (z: -0.45 vs -0.5).
//  ARM_REST_ROT: rotación X más atrás (-0.3), giro Y más pronunciado (-0.4),
//               leve inclinación Z (0.15) para una pose más natural.
const ARM_REST_POS = new THREE.Vector3(0.42, -0.25, -0.45);
const ARM_REST_ROT = new THREE.Euler(-0.3, -0.4, 0.15);

const PUNCH_DURATION = 0.20;
const PUNCH_ANGLE    = Math.PI / 3;
let _punchTimer      = 0;
let _isPunching      = false;

// ── HOTFIX v0.3.1 — Visibilidad del bloque en mano ────────────────────
//  Cambios respecto a la versión anterior:
//    • position.z: 0.1 → -0.25  (Z negativa = delante de la cámara en Three.js)
//    • renderOrder: 999 → 1000   (garantiza renderizado sobre el brazo)
//    • frustumCulled: ya era false; se conserva explícitamente.
function _updateFPHeldItem(type) {
  if (type === _currentHeldType) return;

  if (_heldMesh) {
    _heldMesh.removeFromParent();
    _heldMesh.geometry.dispose();
    _heldMesh = null;
  }

  _currentHeldType = type;

  if (type && MATERIALS[type] && _fpArm) {
    const geo  = new THREE.BoxGeometry(0.25, 0.25, 0.25);
    const mesh = new THREE.Mesh(geo, MATERIALS[type]);
    mesh.position.set(0, -0.6, -0.25);   // HOTFIX: Z negativa → visible frente a la cámara
    mesh.scale.setScalar(1.2);
    mesh.renderOrder = 1000;              // HOTFIX: por encima del brazo (era 999)
    mesh.frustumCulled = false;           // HOTFIX: forzar visibilidad independientemente del frustum
    mesh.userData.sharedMaterial = true;
    _fpArm.add(mesh);
    _heldMesh = mesh;
  }
}

export function triggerPunch() {
  if (_isPunching) return;
  _isPunching = true;
  _punchTimer = 0;
}

export function isPunching() {
  return _isPunching;
}

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
    player.position.set(CONFIG.WORLD_SIZE / 2, 32, CONFIG.WORLD_SIZE / 2);
    player.velocity.set(0, 0, 0);
  }

  // 5. ── SONIDO DE PASOS ──────────────────────────────────────
  //
  //  ALGORITMO:
  //  a) Calculamos la distancia XZ real recorrida en este frame
  //     con las velocidades POST-colisión (player.velocity ya reflejan
  //     si el jugador chocó contra una pared → la distancia real es 0).
  //  b) Solo acumulamos si el jugador está en el suelo (isOnGround).
  //     Esto evita sonidos de paso mientras se está en el aire o cayendo.
  //  c) Umbral STEP_THRESHOLD: cuando la distancia acumulada supera
  //     ~1.8 bloques, se dispara el sonido y se reinicia el acumulador.
  //  d) getBlockType con Y - 0.1 para muestrear el bloque inmediatamente
  //     bajo los pies (recordar: pos.y son los pies → y-0.1 = bloque suelo).
  //
  //  NOTA DE RENDIMIENTO: Math.sqrt() en el cálculo de movedXZ es
  //  necesario aquí porque multiplicamos por dt y necesitamos unidades
  //  correctas de distancia (bloques), no velocidad al cuadrado.
  //  Se ejecuta solo una vez por frame y no en el interior de bucles.

  const movedXZ = Math.sqrt(player.velocity.x ** 2 + player.velocity.z ** 2) * dt;

  if (player.isOnGround && movedXZ > 0.01) {
    stepAccumulator += movedXZ;

    if (stepAccumulator > STEP_THRESHOLD) {
      stepAccumulator = 0;

      // Muestrear el bloque justo debajo de los pies del jugador.
      // Y - 0.1 porque player.position.y apunta a los pies: el bloque
      // de suelo está exactamente en floor(y - epsilon).
      const floorType = getBlockType(
        Math.floor(player.position.x),
        Math.floor(player.position.y - 0.1),
        Math.floor(player.position.z)
      );

      playStepSound(floorType);
    }
  }

  // 6. ── SINCRONIZAR CÁMARA CON HEAD BOBBING ──────────────────
  //
  //  ALGORITMO:
  //  a) El jugador "está caminando" si tiene velocidad horizontal
  //     real (post-colisión) Y está apoyado en el suelo.
  //     Usamos el módulo de velocidad XZ en lugar de las teclas
  //     para que el bob se detenga instantáneamente al chocar con
  //     una pared aunque la tecla siga pulsada.
  //
  //  b) Si camina: avanzar _bobAccum (acumulador de fase) a
  //     BOB_SPEED * dt radianes. El desplazamiento es:
  //       offset = sin(_bobAccum) * BOB_AMPLITUDE
  //     sin() produce un ciclo completo cada 2π segundos a vel. 1.
  //
  //  c) Si no camina: interpolar _bobOffset hacia 0 con lerp
  //     exponencial para que la cabeza regrese suavemente a la
  //     altura base y no se quede a mitad de un paso.
  //     Fórmula:  x += (target - x) * min(1, factor * dt)
  //     El min(1,…) evita overshooting si dt es muy grande.

  const horizSpeed  = Math.hypot(player.velocity.x, player.velocity.z);
  const isWalking   = horizSpeed > 0.1 && player.isOnGround;

  if (isWalking) {
    _bobAccum   += BOB_SPEED * dt;
    _bobOffset   = Math.sin(_bobAccum) * BOB_AMPLITUDE;
  } else {
    // Lerp suave hacia 0: cuando el jugador se detiene la cabeza
    // no para en seco sino que completa el ciclo gradualmente.
    _bobOffset += (0 - _bobOffset) * Math.min(1, BOB_LERP * dt);
  }

  controls.getObject().position.set(
    player.position.x,
    player.position.y + CONFIG.EYE_HEIGHT + _bobOffset,
    player.position.z
  );

  // 7. ── HELD ITEM + ANIMACIÓN DEL BRAZO EN PRIMERA PERSONA ───────
  _updateFPHeldItem(getCurrentBlockType());

  if (_fpArm) {
    if (_isPunching) {
      _punchTimer += dt;
      const t          = Math.min(_punchTimer / PUNCH_DURATION, 1);
      const punchAnim  = Math.sin(t * Math.PI);
      // HOTFIX v0.3.1 — signo positivo: la animación se proyecta hacia adelante
      _fpArm.rotation.x = ARM_REST_ROT.x + (punchAnim * PUNCH_ANGLE);
      _fpArm.position.z = ARM_REST_POS.z - 0.15 * punchAnim;

      if (t >= 1) {
        _isPunching = false;
        _punchTimer = 0;
      }
    } else if (isWalking) {
      const swingX = Math.sin(_bobAccum) * 0.06;
      const swingY = Math.cos(_bobAccum * 2) * 0.03;
      _fpArm.position.x = ARM_REST_POS.x + swingX;
      _fpArm.position.y = ARM_REST_POS.y + swingY;
      _fpArm.position.z = ARM_REST_POS.z;
      _fpArm.rotation.x = ARM_REST_ROT.x + Math.sin(_bobAccum) * 0.08;
      _fpArm.rotation.y = ARM_REST_ROT.y;
      _fpArm.rotation.z = ARM_REST_ROT.z;
    } else {
      const lf = Math.min(1, 10 * dt);
      _fpArm.position.lerp(ARM_REST_POS, lf);
      _fpArm.rotation.x += (ARM_REST_ROT.x - _fpArm.rotation.x) * lf;
      _fpArm.rotation.y += (ARM_REST_ROT.y - _fpArm.rotation.y) * lf;
      _fpArm.rotation.z += (ARM_REST_ROT.z - _fpArm.rotation.z) * lf;
    }
  }
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
export function initPlayer(controls, camera) {
  initKeyboard();
  _camera = camera;

  // Colocar la cámara sobre el jugador desde el primer frame
  controls.getObject().position.set(
    player.position.x,
    player.position.y + CONFIG.EYE_HEIGHT,
    player.position.z
  );

  // ── Brazo en primera persona ──────────────────────────────────
  const model = createPlayerModel(getSavedSkin());
  const armR  = model.userData.armR;

  armR.removeFromParent();
  armR.scale.set(1.6, 1.6, 1.6);
  armR.position.copy(ARM_REST_POS);
  armR.rotation.set(ARM_REST_ROT.x, ARM_REST_ROT.y, ARM_REST_ROT.z);
  armR.renderOrder = 999;
  armR.frustumCulled = false;
  armR.traverse(child => {
    if (child.isMesh) {
      child.renderOrder = 999;
      child.frustumCulled = false;
    }
  });

  _camera.add(armR);
  _fpArm = armR;

  const armMat = armR.material;
  model.traverse(child => {
    if (child === armR) return;
    if (child.isMesh) {
      child.geometry.dispose();
      if (child.material !== armMat) {
        if (child.material.map) child.material.map.dispose();
        child.material.dispose();
      }
    }
  });
}