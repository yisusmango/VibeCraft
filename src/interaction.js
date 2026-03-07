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

/** Comprueba si un bloque en (bx,by,bz) solaparía con el AABB del jugador. */
function wouldOverlapPlayer(bx, by, bz) {
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
 * LÓGICA DE POSICIÓN:
 *   nuevoBloque = bloqueApuntado + round(normalCara)
 *   Ej: normal (0,1,0) → coloca encima; normal (1,0,0) → coloca a la derecha
 *
 * BLOQUE A COLOCAR: getCurrentBlockType() devuelve el tipo del slot
 * activo en el Hotbar, permitiendo colocar cualquiera de los 7 materiales.
 */
function placeBlock() {
  if (!targetBlock || !targetFaceNormal) return;

  const nx = targetBlock.x + Math.round(targetFaceNormal.x);
  const ny = targetBlock.y + Math.round(targetFaceNormal.y);
  const nz = targetBlock.z + Math.round(targetFaceNormal.z);

  if (hasBlock(nx, ny, nz))           return;
  if (wouldOverlapPlayer(nx, ny, nz)) return;

  // ── CAMBIO CLAVE: usa el bloque seleccionado en el Hotbar ──────
  addBlock(nx, ny, nz, getCurrentBlockType());
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