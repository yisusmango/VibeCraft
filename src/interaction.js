// ═══════════════════════════════════════════════════════════════
//  src/interaction.js  —  VibeCraft · Fase 2: Raycaster para InstancedMesh
//
//  CAMBIOS RESPECTO A LA FASE ANTERIOR:
//  ─────────────────────────────────────────────────────────────
//  ANTES  │  blockMap almacenaba THREE.Mesh → un hit siempre tenía
//         │  hit.object.userData.blockPos con las coordenadas.
//
//  AHORA  │  Los bloques sólidos viven en InstancedMeshes.
//         │  Un hit sobre un InstancedMesh tiene hit.instanceId ≠ undefined.
//         │  Las coordenadas se recuperan con:
//         │    hit.object.userData.instances[hit.instanceId]  → {x,y,z,type}
//         │  Las antorchas siguen siendo Mesh individuales y se gestionan
//         │  exactamente igual que antes.
//
//  HIGHLIGHT:
//    • Bloque sólido (InstancedMesh): position.set(bx, by, bz),
//      quaternion identity, scale (1.03, 1.03, 1.03)
//    • Antorcha (Mesh individual): position/quaternion copiados del mesh
//      real, scale (0.22, 0.62, 0.22) para encajar el palo
//
//  FACE NORMAL CON INSTANCEDMESH:
//    hit.face.normal es en espacio local del InstancedMesh.
//    Como nuestros InstancedMeshes tienen transformación identidad
//    (solo posición vía setMatrixAt, sin rotación), el espacio local
//    coincide con el mundo → no se necesita transformación adicional.
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { CONFIG, HALF_W }                                  from './config.js';
import { addBlock, removeBlock, hasBlock, getBlockMeshes } from './world.js';
import { player }                                          from './player.js';
import { getCurrentBlockType }                             from './ui.js';
import { sendBlockUpdate }                                 from './multiplayer.js';

// ═══════════════════════════════════════════════════════════════
//  🎯  RAYCASTER
//  ─────────────────────────────────────────────────────────────
//  MATEMÁTICA:
//  1. setFromCamera(NDC(0,0), camera) reconstruye el rayo desde
//     el centro de la pantalla usando la proyección inversa.
//  2. intersectObjects() sobre InstancedMesh detecta la instancia
//     golpeada y rellena hit.instanceId con su índice.
//  3. hit.object.userData.instances[hit.instanceId] → {x,y,z,type}
//  4. Para COLOCAR: nuevoBloque = bloqueGolpeado + round(normal)
// ═══════════════════════════════════════════════════════════════

const raycaster  = new THREE.Raycaster();
raycaster.far    = CONFIG.MAX_REACH;
const NDC_CENTER = new THREE.Vector2(0, 0);

// ── Wireframe de selección ───────────────────────────────────────
//  Geometría base 1×1×1. La escala se ajusta por frame:
//    • bloque sólido → scale (1.03, 1.03, 1.03)  anti z-fight
//    • antorcha      → scale (0.22, 0.62, 0.22)  encaja el palo
const highlightMesh = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
  new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 1 })
);
highlightMesh.visible = false;

let targetBlock      = null;
let targetFaceNormal = null;

export const getTargetBlock      = () => targetBlock;
export const getTargetFaceNormal = () => targetFaceNormal;

// ═══════════════════════════════════════════════════════════════
//  🔦  updateRaycaster — llamar cada frame
//  ─────────────────────────────────────────────────────────────
//  Flujo de detección:
//    intersectObjects(getBlockMeshes())
//      └─ hit sobre InstancedMesh (instanceId ≥ 0)
//           → coordenadas desde userData.instances[instanceId]
//           → highlight: position.set(bx, by, bz), rot=identity
//      └─ hit sobre Mesh individual (antorcha)
//           → coordenadas desde hit.object.userData.blockPos
//           → highlight: position/quaternion copiados del mesh
// ═══════════════════════════════════════════════════════════════

export function updateRaycaster(camera, controls) {
  if (!controls.isLocked) {
    highlightMesh.visible = false;
    targetBlock = targetFaceNormal = null;
    return;
  }

  raycaster.setFromCamera(NDC_CENTER, camera);
  const hits = raycaster.intersectObjects(getBlockMeshes());

  if (hits.length === 0) {
    targetBlock = targetFaceNormal = null;
    highlightMesh.visible = false;
    return;
  }

  const hit = hits[0];

  // ── ¿Hit sobre un InstancedMesh? ─────────────────────────────────
  //  hit.instanceId es un número ≥ 0 cuando el objeto golpeado es un
  //  InstancedMesh. Para Mesh individuales (antorchas) es undefined.
  if (hit.instanceId !== undefined && hit.object.userData.instances) {

    const inst = hit.object.userData.instances[hit.instanceId];

    // inst puede ser undefined si el rebuild está en progreso y el
    // instanceId aún no fue rellenado. Protección defensiva:
    if (!inst) {
      targetBlock = targetFaceNormal = null;
      highlightMesh.visible = false;
      return;
    }

    targetBlock      = { x: inst.x, y: inst.y, z: inst.z };
    targetFaceNormal = hit.face.normal.clone();
    // face.normal en espacio local del InstancedMesh.
    // Nuestros InstancedMeshes no tienen rotación (solo setPosition),
    // así que local == world y no necesitamos transformar el vector.

    // Highlight: posición exacta en grid, sin rotación, escala 1.03
    highlightMesh.position.set(inst.x, inst.y, inst.z);
    highlightMesh.quaternion.set(0, 0, 0, 1);  // identidad
    highlightMesh.scale.set(1.03, 1.03, 1.03);
    highlightMesh.visible = true;

  } else {
    // ── Hit sobre Mesh individual (antorcha) ───────────────────────
    //  Las antorchas conservan userData.blockPos, .blockType y la
    //  posición/rotación real del mesh para el highlight.
    targetBlock      = hit.object.userData.blockPos;
    targetFaceNormal = hit.face.normal.clone();

    // Copiar posición y rotación del mesh real de la antorcha para que
    // el wireframe se incline junto con el palo (≠ block grid position)
    highlightMesh.position.copy(hit.object.position);
    highlightMesh.quaternion.copy(hit.object.quaternion);

    if (hit.object.userData.blockType === 'torch') {
      highlightMesh.scale.set(0.22, 0.62, 0.22);
    } else {
      highlightMesh.scale.set(1.03, 1.03, 1.03);
    }

    highlightMesh.visible = true;
  }
}

// ═══════════════════════════════════════════════════════════════
//  🖱️  ACCIONES DE INTERACCIÓN
// ═══════════════════════════════════════════════════════════════

// ── Tipos no sólidos ─────────────────────────────────────────────
//  Los bloques de esta lista tienen geometría menor a 1×1×1,
//  por lo que su celda no impide colocar un bloque adyacente
//  aunque el jugador esté cerca.
const NON_SOLID_TYPES = new Set(['torch']);

/**
 * Comprueba si un bloque en (bx,by,bz) solaparía con el AABB del jugador.
 * Devuelve false para tipos no sólidos (antorchas).
 */
function wouldOverlapPlayer(bx, by, bz, blockType = 'grass') {
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
  const { x, y, z } = targetBlock;
  removeBlock(x, y, z);
  sendBlockUpdate('remove', x, y, z, null, null);  // notificar a otros
  targetBlock = null;
  highlightMesh.visible = false;
}

/**
 * Coloca un bloque en la cara adyacente del bloque apuntado (clic derecho).
 * Pasa targetFaceNormal a addBlock para que world.js pueda orientar
 * correctamente las antorchas en pared.
 */
function placeBlock() {
  if (!targetBlock || !targetFaceNormal) return;

  const nx = targetBlock.x + Math.round(targetFaceNormal.x);
  const ny = targetBlock.y + Math.round(targetFaceNormal.y);
  const nz = targetBlock.z + Math.round(targetFaceNormal.z);

  const selectedType = getCurrentBlockType();

  if (hasBlock(nx, ny, nz))                         return;
  if (wouldOverlapPlayer(nx, ny, nz, selectedType)) return;

  addBlock(nx, ny, nz, selectedType, targetFaceNormal);
  sendBlockUpdate('add', nx, ny, nz, selectedType, targetFaceNormal);  // notificar a otros
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