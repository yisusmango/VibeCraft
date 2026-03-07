// ═══════════════════════════════════════════════════════════════
//  src/interaction.js
//  Responsabilidades:
//    • Raycaster: detectar el bloque al que mira el jugador
//    • Highlight: wireframe negro sobre el bloque apuntado
//    • destroyBlock (clic izquierdo) — elimina el bloque objetivo
//    • placeBlock   (clic derecho)   — coloca un bloque adyacente
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { CONFIG, HALF_W } from './config.js';
import { addBlock, removeBlock, hasBlock, getBlockMeshes } from './world.js';
import { player } from './player.js';

// ═══════════════════════════════════════════════════════════════
//  🎯  RAYCASTER
//  ─────────────────────────────────────────────────────────────
//  MATEMÁTICA:
//  1. setFromCamera(NDC_CENTER, camera) reconstruye el rayo desde
//     el punto (0,0) en Normalized Device Coordinates (centro de
//     la pantalla) usando la matriz de proyección inversa de la
//     cámara. El rayo tiene origen en la cámara y dirección
//     hacia el frente (hacia donde mira el jugador).
//
//  2. intersectObjects() prueba el rayo contra cada mesh:
//     a. Test rayo-BoundingBox  →  O(1), muy barato
//     b. Test rayo-triángulo (Möller–Trumbore) si pasa el AABB
//        — 12 triángulos por cubo → 12 tests en el peor caso
//
//  3. El resultado más cercano nos da:
//     • object          → el Mesh golpeado (userData.blockPos)
//     • face.normal     → normal de la cara en espacio local
//       Ej: (0,1,0) = cara superior, (1,0,0) = cara derecha
//
//  4. Para COLOCAR: nuevo_bloque = bloque_golpeado + normal
//     (Math.round para sobrevivir imprecisión flotante)
// ═══════════════════════════════════════════════════════════════

const raycaster  = new THREE.Raycaster();
raycaster.far    = CONFIG.MAX_REACH;

// NDC (0,0) = centro exacto de la pantalla
const NDC_CENTER = new THREE.Vector2(0, 0);

// ── Highlight ────────────────────────────────────────────────────
// Wireframe negro ligeramente más grande que 1 (1.03) para evitar
// z-fighting con la superficie del bloque apuntado.
const highlightMesh = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1.03, 1.03, 1.03)),
  new THREE.LineBasicMaterial({ color: 0x000000 })
);
highlightMesh.visible = false;

// ── Estado interno ───────────────────────────────────────────────
let targetBlock      = null;  // { x, y, z } del bloque apuntado
let targetFaceNormal = null;  // THREE.Vector3 — normal de la cara golpeada

// ── Getters públicos (solo lectura para ui.js) ────────────────────
export const getTargetBlock      = () => targetBlock;
export const getTargetFaceNormal = () => targetFaceNormal;

// ═══════════════════════════════════════════════════════════════
//  🔦  updateRaycaster — llamar cada frame
// ═══════════════════════════════════════════════════════════════

/**
 * Lanza el rayo desde el centro de la pantalla y actualiza
 * targetBlock, targetFaceNormal y la visibilidad del highlight.
 * @param {THREE.Camera} camera
 * @param {object}       controls — PointerLockControls
 */
export function updateRaycaster(camera, controls) {
  if (!controls.isLocked) {
    highlightMesh.visible = false;
    targetBlock = targetFaceNormal = null;
    return;
  }

  raycaster.setFromCamera(NDC_CENTER, camera);

  // getBlockMeshes() usa cache: no reconstruye el array si el mundo no cambió
  const hits = raycaster.intersectObjects(getBlockMeshes());

  if (hits.length > 0) {
    const hit        = hits[0];                        // bloque más cercano
    targetBlock      = hit.object.userData.blockPos;  // coords del bloque
    targetFaceNormal = hit.face.normal.clone();        // normal de la cara

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

/**
 * Comprueba si un bloque hipotético en (bx,by,bz) solaparía con
 * el AABB actual del jugador. Se usa para evitar colocar bloques
 * dentro del propio cuerpo del jugador.
 * @returns {boolean}
 */
function wouldOverlapPlayer(bx, by, bz) {
  const px = player.position.x;
  const py = player.position.y;
  const pz = player.position.z;
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
 * Coloca un nuevo bloque en la cara adyacente al bloque apuntado
 * (clic derecho).
 *
 * LÓGICA DE POSICIÓN:
 *   nuevoBloque = bloqueApuntado + redondear(normalCara)
 *   Ej: cara superior (+Y normal)  → coloca encima
 *       cara lateral  (+X normal)  → coloca a la derecha
 *
 * Math.round() absorbe la imprecisión flotante de face.normal
 * (puede ser 0.9999... en vez de exactamente 1).
 */
function placeBlock() {
  if (!targetBlock || !targetFaceNormal) return;

  const nx = targetBlock.x + Math.round(targetFaceNormal.x);
  const ny = targetBlock.y + Math.round(targetFaceNormal.y);
  const nz = targetBlock.z + Math.round(targetFaceNormal.z);

  if (hasBlock(nx, ny, nz))           return;  // posición ya ocupada
  if (wouldOverlapPlayer(nx, ny, nz)) return;  // colisionaría con el jugador

  addBlock(nx, ny, nz, 'dirt');
}

// ═══════════════════════════════════════════════════════════════
//  🚀  INICIALIZACIÓN
// ═══════════════════════════════════════════════════════════════

/**
 * Inicializa el módulo de interacción:
 *   - Añade el mesh de highlight a la escena
 *   - Registra listeners de ratón
 *
 * @param {THREE.Scene} scene
 * @param {object}      controls — PointerLockControls
 */
export function initInteraction(scene, controls) {
  scene.add(highlightMesh);

  // Escuchar mousedown solo cuando el puntero está bloqueado
  document.addEventListener('mousedown', (e) => {
    if (!controls.isLocked) return;
    e.preventDefault();
    if (e.button === 0) destroyBlock();  // ← clic izquierdo: DESTRUIR
    if (e.button === 2) placeBlock();    // ← clic derecho:   COLOCAR
  });

  // Desactivar el menú contextual del navegador (clic derecho)
  document.addEventListener('contextmenu', (e) => e.preventDefault());
}