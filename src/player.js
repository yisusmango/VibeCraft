// ═══════════════════════════════════════════════════════════════
//  src/player.js
//  Responsabilidades:
//    • Estado del jugador (position, velocity, isOnGround)
//    • Captura de teclado (WASD + Espacio)
//    • Detección de colisiones AABB contra el mundo
//    • Bucle de física: gravedad, movimiento y resolución por eje
//    • Sincronización cámara → posición del jugador
//    • Sistema de sonido de pasos (stepAccumulator)
//    • Arm Sway: inercia del brazo al mover la cámara (v0.3.2)
//
//  CAMBIOS v0.3.3 (animation polish):
//    1. armR.scale.set(1.1, 1.6, 1.1)  — brazo más delgado y largo
//    2. _heldMesh.rotation.set(π/8, π/4, 0)  — bloque en perspectiva isométrica
//    3. Arm Sway con roll en Z + SWAY_LERP 8.0 → 5.0 (más elástico)
//
//  CAMBIOS v0.3.4 (perspectiva Minecraft):
//    1. armR.scale.set(0.25, 0.8, 0.25)  — proporción prisma 1:3:1
//    2. ARM_REST_POS (0.5, -0.4, -0.3) + ARM_REST_ROT (-1.1, 0.4, 0.15)
//       Brazo sale de esquina inferior derecha apuntando al centro-frente
//    3. _heldMesh.position.set(0, -0.8, -0.1) + rotation.set(π/8, π/5, 0)
//       Ítem acoplado a la mano (fondo del brazo) con perspectiva isométrica
//
//  CAMBIOS v0.3.5 (visibilidad del brazo):
//    1. armR.scale.set(0.4, 1.2, 0.4)  — escala aumentada, proporción alargada mantenida
//    2. ARM_REST_POS (0.35, -0.25, -0.45)  — brazo más cerca, más arriba, bien encuadrado
//       ARM_REST_ROT sin cambios (-1.1, 0.4, 0.15)
//    3. _heldMesh.position.set(0, -1.0, -0.1)  — ítem bajado al nuevo extremo distal (scale.y=1.2)
//
//  CAMBIOS v0.3.6 (corrección escala heredada del ítem):
//    • _heldMesh.scale.set(1.0, 0.33, 1.0)  — escala inversa del brazo padre (0.4, 1.2, 0.4)
//      para que el bloque sea un cubo perfecto ~0.4 × 0.4 × 0.4 en world space
//    • _heldMesh.position.set(0, -0.85, 0.15) — sacado a la superficie de la mano
//    • _heldMesh.rotation.set(π/8, π/5, 0)   — perspectiva isométrica conservada
//
//  CAMBIOS v0.3.7 (patrón contenedor — fix definitivo del shear):
//    • armContainer (THREE.Group) recibe ARM_REST_POS y ARM_REST_ROT.
//      armR se añade al grupo con posición/rotación en (0,0,0) y escala (0.4,1.2,0.4).
//      _heldMesh se añade también al grupo como hermano de armR, sin heredar su escala.
//    • _updateFPHeldItem: BoxGeometry(0.35,0.35,0.35), scale(1,1,1), sin hack de inversa.
//      posición (0, -1.0, -0.15), rotación isométrica (π/8, π/5, 0) sin deformación.
//
//  CAMBIOS v0.3.8 (corrección eje Z del ítem):
//    • mesh.position.set(0, -1.0, 0.2)  — Z positivo: bloque al frente del brazo (nudillos)
//    • mesh.rotation.set(π/6, π/4, 0)   — cara superior e izquierda bien visibles
//
//  CAMBIOS v0.3.9 (corrección eje Y del ítem):
//    • mesh.position.set(0, 0.75, 0.15) — Y positivo: punta frontal del brazo (mano)
//      Con armContainer.rotation.x = -1.1, el eje Y local apunta hacia adelante-arriba
//      en world space. Y negativo enviaba el bloque hacia el hombro/fuera de pantalla.
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

// ═══════════════════════════════════════════════════════════════
//  💫  ARM SWAY — inercia del brazo al mover la cámara (v0.3.3)
//  ─────────────────────────────────────────────────────────────
//  SWAY_FACTOR → multiplicador de la delta de rotación.
//                Negativo = inercia opuesta (brazo se queda atrás).
//  SWAY_LERP   → velocidad de retorno a 0 cuando la cámara se detiene.
//                v0.3.3: 8.0 → 5.0 para un retorno más elástico y menos
//                rígido. Un valor menor alarga la "cola" del movimiento,
//                dando sensación de peso real al brazo.
//  SWAY_CLAMP  → límite máximo en radianes para sacudidas bruscas.
// ═══════════════════════════════════════════════════════════════
const SWAY_FACTOR = -0.1;
const SWAY_LERP   = 5.0;   // ← v0.3.3: era 8.0; más bajo = más elástico
const SWAY_CLAMP  = 0.12;

let _bobAccum  = 0;  // acumulador de fase (radianes), avanza solo al caminar
let _bobOffset = 0;  // offset Y actual aplicado a la cámara (suavizado)

// Arm Sway: rotación de cámara del frame anterior y acumulador de sway
let _prevCamRot = new THREE.Vector2();  // (yaw, pitch) del frame anterior
let _targetSway = new THREE.Vector2();  // sway actual (suavizado hacia 0)

// ═══════════════════════════════════════════════════════════════
//  First-Person Arm
// ═══════════════════════════════════════════════════════════════

let _fpArm            = null;
let _armR             = null;   // v0.4.1: referencia directa a armR para pivotar solo el brazo
let _camera           = null;
let _heldMesh         = null;
let _currentHeldType  = null;

// ── v0.3.5 — Pose de reposo: visibilidad mejorada ───────────────────────
//  ARM_REST_POS ajustada para que el brazo entre en el encuadre de la cámara.
//    X: +0.35 → menos desplazado a la derecha que en v0.3.4 (era 0.5),
//               el brazo queda más centrado y visible sin salirse del FOV.
//    Y: -0.25 → más arriba que en v0.3.4 (era -0.4), compensando que la
//               escala Y=1.2 proyecta el brazo más hacia abajo en pantalla.
//    Z: -0.45 → más cerca de la cámara que en v0.3.4 (era -0.3), el brazo
//               aparece más grande y legible en el ángulo de visión del jugador.
//
//  ARM_REST_ROT: sin cambios respecto a v0.3.4.
//    X: -1.1 rad (~63°)  → inclina el brazo hacia adelante (perspectiva correcta).
//    Y: +0.4 rad (~23°)  → gira la mano hacia el centro de la pantalla.
//    Z: +0.15 rad (~9°)  → leve ladeo (roll) característico del brazo de Minecraft.
const ARM_REST_POS = new THREE.Vector3(0.35, -0.25, -0.45);
const ARM_REST_ROT = new THREE.Euler(-1.1, 0.4, 0.15);

const PUNCH_DURATION = 0.20;
const PUNCH_ANGLE    = Math.PI / 3;
let _punchTimer      = 0;
let _isPunching      = false;

// ── Mining Swing — animación continua de picado (v0.4.1) ─────────────────
//  MINING_SWING_SPEED → frecuencia del ciclo de swing (rad/seg).
//  MINING_SWING_ANGLE → amplitud máxima en radianes (~23°).
//  MINING_RETURN_LERP → velocidad de suavizado al dejar de picar.
const MINING_SWING_SPEED = 15.0;
const MINING_SWING_ANGLE = 0.4;
const MINING_RETURN_LERP = 8.0;

let _isMining      = false;
let _miningTime    = 0;

// ── v0.3.7 — Ítem como hermano de armR en armContainer (sin shear) ────────
//
//  PROBLEMA RAÍZ (v0.3.6):
//    La matriz de transformación de un objeto 3D es M = T · R · S.
//    Cuando armR tiene escala no uniforme (0.4, 1.2, 0.4) y un hijo
//    lleva rotación isométrica (π/8, π/5, 0), la concatenación de matrices
//    produce Cizalladura (Shear): los ejes del hijo dejan de ser ortogonales
//    en world space. Ninguna escala inversa puede corregir esto porque el
//    shear está codificado en la sub-matrix 3×3 resultante de R_padre × S_padre.
//
//  SOLUCIÓN — Patrón Contenedor:
//    _fpArm ahora es un THREE.Group (armContainer) con escala (1,1,1).
//    - armR  es hijo del grupo con su propia escala no uniforme (0.4,1.2,0.4).
//    - _heldMesh es HERMANO de armR, también hijo del grupo.
//    El grupo tiene escala identidad → _heldMesh no hereda ninguna distorsión.
//    La posición relativa al extremo de la mano se expresa en espacio del grupo,
//    que coincide con el espacio de la cámara (ambos a escala 1).
//
//  Posición (0, -1.0, -0.15):
//    Y: -1.0  → extremo distal del brazo expresado en espacio del grupo.
//               Con armR.scale.y=1.2 y ROT.x=-1.1 la mano proyectada queda
//               aproximadamente a -1.0 en Y del grupo (ver cálculo abajo).
//               Aproximación: 1.2 × sin(1.1) ≈ 1.2 × 0.891 ≈ 1.07 → -1.0 es conservador.
//    Z: -0.15 → offset adelante en espacio del grupo (≈ hacia la cámara)
//               para que el cubo asome por delante de la geometría del brazo.
//
//  Geometría BoxGeometry(0.35, 0.35, 0.35) + scale(1,1,1):
//    Cubo 0.35 × 0.35 × 0.35 perfecto en world space, sin deformación.
//
//  renderOrder: 1000  (sobre armR, renderOrder 999)
//  frustumCulled: false (forzar visibilidad fuera del frustum)
function _updateFPHeldItem(type) {
  if (type === _currentHeldType) return;

  if (_heldMesh) {
    _heldMesh.removeFromParent();
    _heldMesh.geometry.dispose();
    _heldMesh = null;
  }

  _currentHeldType = type;

  if (type && MATERIALS[type] && _fpArm) {
    const geo  = new THREE.BoxGeometry(0.1, 0.1, 0.1);  // ← v0.3.7: cubo mayor, sin shear
    const mesh = new THREE.Mesh(geo, MATERIALS[type]);
    mesh.scale.set(1.0, 1.0, 1.0);                          // ← v0.3.7: sin hack de inversa
    mesh.position.set(-0.05, 0.035, 0);                        // ← v0.3.9: Y positivo → punta frontal del brazo (mano); Z apoya sobre nudillos
    mesh.rotation.set(Math.PI / 8, Math.PI / 4, 0);          // perspectiva isométrica: cara superior e izquierda visibles
    mesh.renderOrder = 1000;                                 // por encima del brazo
    mesh.frustumCulled = false;                              // forzar visibilidad fuera del frustum
    mesh.userData.sharedMaterial = true;
    _fpArm.add(mesh);   // _fpArm es ahora armContainer → sin herencia de escala no uniforme
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

/**
 * Activa o desactiva la animación continua de Mining Swing.
 * Llamar desde interaction.js en mousedown/mouseup.
 * @param {boolean} active
 */
export function setMining(active) {
  _isMining = active;
  if (!active) _miningTime = 0;
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

    // ── Mining Swing — rota armR en su eje X local (pivote en el hombro) ──
    //  Se aplica a _armR (no al armContainer) para que la BASE del brazo
    //  permanezca fija y solo el extremo distal balancee hacia adelante.
    //  El armContainer mantiene siempre ARM_REST_ROT, evitando que el
    //  bloque de la mano se desplace fuera de su posición de reposo.
    //  Durante Punch, armR vuelve suavemente a 0 para no chocar con el golpe.
    if (_armR) {
      if (_isPunching) {
        // Punch tiene prioridad: devolver armR a neutro sin salto
        _armR.rotation.x += (0 - _armR.rotation.x) * Math.min(1, MINING_RETURN_LERP * dt);
      } else if (_isMining) {
        _miningTime += dt;
        _armR.rotation.x = Math.sin(_miningTime * MINING_SWING_SPEED) * MINING_SWING_ANGLE;
      } else {
        // Soltar botón: lerp suave de vuelta a 0 y reset del acumulador
        _miningTime  = 0;
        _armR.rotation.x += (0 - _armR.rotation.x) * Math.min(1, MINING_RETURN_LERP * dt);
        if (Math.abs(_armR.rotation.x) < 0.001) _armR.rotation.x = 0;
      }
    }
  }

  // 8. ── ARM SWAY (inercia del brazo al mover la cámara) ──────────
  //
  //  ALGORITMO:
  //  a) Leemos yaw del yaw-object (controls.getObject().rotation.y)
  //     y pitch de _camera.rotation.x.
  //     PointerLockControls desacopla los dos ejes en objetos distintos:
  //       yaw-object  → hijo de scene, guarda la rotación horizontal (Y)
  //       _camera     → hijo del yaw-object, guarda la rotación vertical (X)
  //
  //  b) delta = rotación_actual - rotación_anterior.
  //     El signo resultante refleja la dirección del giro.
  //
  //  c) _targetSway += delta * SWAY_FACTOR
  //     SWAY_FACTOR negativo → inercia opuesta al movimiento de cámara.
  //     Ejemplo: girar a la derecha (yaw sube) → brazo se queda atrás → sway.y baja.
  //
  //  d) Lerp de retorno a (0, 0): simula la "tensión" que devuelve
  //     el brazo a su posición natural cuando la cámara se detiene.
  //     SWAY_LERP=5.0 (antes 8.0) → retorno más lento y elástico,
  //     el brazo "rebota" ligeramente antes de asentarse.
  //
  //  e) Clamp ±SWAY_CLAMP para que sacudidas bruscas no roten el brazo
  //     de forma absurda.
  //
  //  f) SUMA el sway a _fpArm.rotation DESPUÉS de walk/punch/idle:
  //     actúa como capa aditiva, no sobreescribe.
  //
  //     EJES (v0.3.3):
  //       rotation.x += _targetSway.y  — pitch de cámara mueve el brazo
  //                                       arriba/abajo (eje correcto: Y del sway)
  //       rotation.y += _targetSway.x  — yaw de cámara gira el brazo
  //                                       izquierda/derecha (eje correcto: X del sway)
  //       rotation.z += _targetSway.x * 0.5  — roll lateral: cuando el jugador
  //                                       gira rápido hacia los lados el brazo
  //                                       se ladea ligeramente, dando sensación
  //                                       de peso e inercia real.
  //
  //  g) Guarda el estado actual en _prevCamRot para el siguiente frame.
  if (_fpArm && _camera) {
    const yawObj   = controls.getObject();
    const curYaw   = yawObj.rotation.y;
    const curPitch = _camera.rotation.x;

    // b) Deltas respecto al frame anterior
    const deltaYaw   = curYaw   - _prevCamRot.x;
    const deltaPitch = curPitch - _prevCamRot.y;

    // c) Acumular sway con inercia opuesta
    _targetSway.x += deltaPitch * SWAY_FACTOR;
    _targetSway.y += deltaYaw   * SWAY_FACTOR;

    // d) Lerp suave de retorno a 0 (SWAY_LERP=5.0 → más elástico que antes)
    const sf = Math.min(1, SWAY_LERP * dt);
    _targetSway.x += (0 - _targetSway.x) * sf;
    _targetSway.y += (0 - _targetSway.y) * sf;

    // e) Clamp para evitar valores extremos
    _targetSway.x = THREE.MathUtils.clamp(_targetSway.x, -SWAY_CLAMP, SWAY_CLAMP);
    _targetSway.y = THREE.MathUtils.clamp(_targetSway.y, -SWAY_CLAMP, SWAY_CLAMP);

    // f) Aplicar el sway ENCIMA de la animación de caminar / respirar
    //    v0.3.3: ejes corregidos + roll en Z para efecto de peso al girar
    _fpArm.rotation.x += _targetSway.y;        // pitch de cámara → tilt vertical del brazo
    _fpArm.rotation.y += _targetSway.x;        // yaw de cámara   → swing horizontal del brazo
    _fpArm.rotation.z += _targetSway.x * 0.5;  // roll lateral    → ladeo por inercia al girar

    // g) Guardar estado para el siguiente frame
    _prevCamRot.set(curYaw, curPitch);
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

  // ── Instanciar el modelo del jugador y extraer el brazo derecho ─────────
  const model = createPlayerModel(getSavedSkin());
  const armR  = model.userData.armR;
  armR.removeFromParent();

  // ── v0.3.7 — Patrón Contenedor: armContainer como _fpArm ────────────────
  //
  //  JERARQUÍA RESULTANTE:
  //    _camera
  //      └─ armContainer  (THREE.Group, scale 1,1,1)  ← _fpArm
  //           ├─ armR     (Mesh del brazo,  scale 0.4,1.2,0.4, pos/rot (0,0,0))
  //           └─ _heldMesh (Mesh del ítem, scale 1,1,1, sin herencia de escala)
  //
  //  POR QUÉ FUNCIONA:
  //    Las animaciones (walk/punch/idle/sway) operan sobre armContainer,
  //    moviendo y rotando el grupo entero. Dentro del grupo, armR y _heldMesh
  //    son hermanos: _heldMesh no hereda la escala no uniforme de armR y por
  //    tanto no sufre shear cuando se le aplica rotación isométrica.
  //
  //  ARM_REST_POS / ARM_REST_ROT se asignan al GRUPO (no a armR):
  //    armR tiene pos/rot en (0,0,0) dentro del grupo; su escala define la
  //    forma del brazo pero no afecta al espacio de coordenadas del grupo.
  const armContainer = new THREE.Group();
  armContainer.position.copy(ARM_REST_POS);
  armContainer.rotation.set(ARM_REST_ROT.x, ARM_REST_ROT.y, ARM_REST_ROT.z);
  armContainer.renderOrder = 999;
  armContainer.frustumCulled = false;

  // armR: posición y rotación a cero (hereda la del grupo), escala 1:3:1 intacta
  armR.removeFromParent();
  armR.position.set(0, 0, 0);
  armR.rotation.set(0, 0, 0);
  armR.scale.set(0.4, 1.2, 0.4);
  armR.renderOrder = 999;
  armR.frustumCulled = false;
  _armR = armR;   // v0.4.1: guardar referencia para pivotar solo el brazo en mining
  armR.traverse(child => {
    if (child.isMesh) {
      child.renderOrder = 999;
      child.frustumCulled = false;
    }
  });

  armContainer.add(armR);
  _camera.add(armContainer);
  _fpArm = armContainer;  // las animaciones moverán el grupo completo

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