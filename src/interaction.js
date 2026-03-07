// ═══════════════════════════════════════════════════════════════
//  src/interaction.js
//  Responsabilidades:
//    • Raycaster: detectar el bloque al que mira el jugador
//    • Highlight: wireframe negro sobre el bloque apuntado
//    • destroyBlock (clic izquierdo)
//    • placeBlock   (clic derecho) — usa getCurrentBlockType() de ui.js
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { CONFIG, HALF_W }                              from './config.js';
import { addBlock, removeBlock, hasBlock, getBlockMeshes } from './world.js';
import { player }                                      from './player.js';
// ── NUEVO: leer el tipo de bloque seleccionado en el Hotbar ─────
import { getCurrentBlockType }                         from './ui.js';

// ═══════════════════════════════════════════════════════════════
//  🎯  RAYCASTER
//  ─────────────────────────────────────────────────────────────
//  MATEMÁTICA:
//  1. setFromCamera(NDC_CENTER, camera) reconstruye el rayo desde
//     el centro de la pantalla (NDC 0,0) usando la proyección
//     inversa de la cámara.
//  2. intersectObjects() hace test rayo-BoundingBox (O(1)) y luego
//     rayo-triángulo Möller–Trumbore por cada cara del cubo.
//  3. face.normal devuelve la normal de la cara golpeada en espacio
//     objeto: (0,1,0)=superior, (1,0,0)=derecha, etc.
//  4. Para COLOCAR: nuevoBloque = bloqueGolpeado + round(normal)
// ═══════════════════════════════════════════════════════════════

const raycaster  = new THREE.Raycaster();
raycaster.far    = CONFIG.MAX_REACH;
const NDC_CENTER = new THREE.Vector2(0, 0);

// Wireframe de selección: 1.03 > 1 para evitar z-fighting
const highlightMesh = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.03, 1.03, 1.03)),
  new THREE.LineBasicMaterial({ color: 0x000000 })
);
highlightMesh.visible = false;

let targetBlock      = null;
let targetFaceNormal = null;

export const getTargetBlock      = () => targetBlock;
export const getTargetFaceNormal = () => targetFaceNormal;

// ═══════════════════════════════════════════════════════════════
//  🔦  updateRaycaster — llamar cada frame
// ═══════════════════════════════════════════════════════════════

export function updateRaycaster(camera, controls) {
  if (!controls.isLocked) {
    highlightMesh.visible = false;
    targetBlock = targetFaceNormal = null;
    return;
  }

  raycaster.setFromCamera(NDC_CENTER, camera);
  const hits = raycaster.intersectObjects(getBlockMeshes());

  if (hits.length > 0) {
    const hit        = hits[0];
    targetBlock      = hit.object.userData.blockPos;
    targetFaceNormal = hit.face.normal.clone();
    highlightMesh.position.set(targetBlock.x, targetBlock.y, targetBlock.z);
    highlightMesh.visible = true;
  } else {
    targetBlock = targetFaceNormal = null;
    highlightMesh.visible = false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  🖱️  ACCIONES DE INTERACCIÓN
// ═══════════════════════════════════════════════════════════════

// ── Bloques no sólidos ───────────────────────────────────────────
//  Estos tipos tienen geometría menor al cubo 1×1×1, por lo que NO
//  deben bloquear la colocación aunque el jugador esté en la celda
//  adyacente. Sin esto, wouldOverlapPlayer usaría dimensiones 1×1×1
//  y rechazaría colocar una antorcha junto al jugador aunque el palo
//  de 0.2×0.6×0.2 no le alcance físicamente.
//
//  NOTA: player.js sigue usando hasBlock() para colisiones, lo que
//  significa que la AABB del jugador seguirá chocando con la celda
//  de la antorcha (1×1×1 lógica). Esto es un trade-off aceptable
//  para esta fase; en una fase futura se puede añadir un mapa de
//  colisión por tipo de bloque en config.js.
const NON_SOLID_TYPES = new Set(['torch']);

/**
 * Comprueba si un bloque en (bx,by,bz) solaparía con el AABB del jugador.
 * Si el bloque es de tipo no sólido (antorcha, etc.) siempre devuelve false.
 * @param {number} bx
 * @param {number} by
 * @param {number} bz
 * @param {string} [blockType='grass'] — tipo del bloque a colocar
 * @returns {boolean}
 */
function wouldOverlapPlayer(bx, by, bz, blockType = 'grass') {
  // Los bloques no sólidos pueden colocarse junto al jugador sin problema
  if (NON_SOLID_TYPES.has(blockType)) return false;

  const { x: px, y: py, z: pz } = player.position;
  return (
    px + HALF_W               > bx - 0.5 && px - HALF_W               < bx + 0.5 &&
    py + CONFIG.PLAYER_HEIGHT > by - 0.5 && py                         < by + 0.5 &&
    pz + HALF_W               > bz - 0.5 && pz - HALF_W               < bz + 0.5
  );
}

/** Destruye el bloque apuntado (clic izquierdo). */
function destroyBlock() {
  if (!targetBlock) return;
  removeBlock(targetBlock.x, targetBlock.y, targetBlock.z);
  targetBlock = null;
  highlightMesh.visible = false;
}

/**
 * Coloca un bloque en la cara adyacente del bloque apuntado (clic derecho).
 *
 * CAMBIO: se pasa `targetFaceNormal` como quinto argumento a addBlock.
 * world.js lo usa para determinar la orientación de la antorcha:
 *   • normal (0,+1,0) → suelo  → antorcha vertical
 *   • normal (0,−1,0) → techo  → colocación cancelada en world.js
 *   • normal (±1,0,0) → pared  → antorcha inclinada 30° en eje Z
 *   • normal (0,0,±1) → pared  → antorcha inclinada 30° en eje X
 *
 * Para bloques normales el normal se ignora completamente.
 */
function placeBlock() {
  if (!targetBlock || !targetFaceNormal) return;

  const nx = targetBlock.x + Math.round(targetFaceNormal.x);
  const ny = targetBlock.y + Math.round(targetFaceNormal.y);
  const nz = targetBlock.z + Math.round(targetFaceNormal.z);

  const selectedType = getCurrentBlockType();

  if (hasBlock(nx, ny, nz))                          return;
  if (wouldOverlapPlayer(nx, ny, nz, selectedType))  return;

  // ── CAMBIO: pasar el vector normal para orientar la antorcha ──
  addBlock(nx, ny, nz, selectedType, targetFaceNormal);
}

// ═══════════════════════════════════════════════════════════════
//  🚀  INICIALIZACIÓN
// ═══════════════════════════════════════════════════════════════

export function initInteraction(scene, controls) {
  scene.add(highlightMesh);

  document.addEventListener('mousedown', (e) => {
    if (!controls.isLocked) return;
    e.preventDefault();
    if (e.button === 0) destroyBlock();
    if (e.button === 2) placeBlock();
  });

  document.addEventListener('contextmenu', (e) => e.preventDefault());
}