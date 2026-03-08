// ═══════════════════════════════════════════════════════════════
//  src/world.js  —  VibeCraft · Fase 2: InstancedMesh + Occlusion Culling
//
//  ARQUITECTURA DE ESTA FASE:
//  ─────────────────────────────────────────────────────────────
//  ANTES  │  blockMap → Map<key, THREE.Mesh>
//         │  addBlock() crea un Mesh por bloque → miles de draw calls
//
//  AHORA  │  blockMap → Map<key, BlockData>  (datos puros, sin Three.js)
//         │  rebuildWorldMeshes() crea UN InstancedMesh por tipo
//         │  → draw calls ≈ número de tipos únicos visibles (máx 7)
//
//  BlockData = { x, y, z, type, normal, isSolid, mesh? }
//    • mesh solo existe en antorchas (geometría no estándar + PointLight)
//
//  OCCLUSION CULLING:
//    Un bloque cuyas 6 caras estén completamente cubiertas por vecinos
//    opacos nunca es visible → se omite del InstancedMesh.
//    glass / leaves / torch son transparentes y NO ocluyen vecinos.
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createNoise2D } from 'https://unpkg.com/simplex-noise@4.0.1/dist/esm/simplex-noise.js';

let _scene = null;
export function initWorld(scene) { _scene = scene; }

// ═══════════════════════════════════════════════════════════════
//  🎨  HELPERS DE TEXTURA
// ═══════════════════════════════════════════════════════════════

function makeTexture(size, fn) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  fn(canvas.getContext('2d'), size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestMipmapNearestFilter;
  return tex;
}

function noiseFill(ctx, x0, y0, w, h, palette) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      ctx.fillStyle = palette[(Math.random() * palette.length) | 0];
      ctx.fillRect(x, y, 1, 1);
    }
}

const S = 16;

// ── Hierba ──────────────────────────────────────────────────────
const texGrassTop = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#5d8a3c','#4a7a2b','#6a9a49','#52803a','#3d6a2b']);
});
const texGrassSide = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#8B5E3C','#7a4d2b','#9a6e4c','#6a3d1c']);
  // Franja verde en las primeras 4 filas → parte SUPERIOR de la cara lateral
  noiseFill(ctx, 0, 0, w, 4, ['#5d8a3c','#4a7a2b','#6a9a49','#52803a']);
});
const texDirt = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#8B5E3C','#7a4d2b','#9a6e4c','#6a3d1c','#a07040']);
});

// ── Piedra ───────────────────────────────────────────────────────
const texStone = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#888','#7a7a7a','#969696','#6e6e6e','#a0a0a0']);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = '#505050';
    ctx.fillRect((Math.random() * (w - 1)) | 0, (Math.random() * (h - 2)) | 0, 1, 2);
  }
});

// ── Madera ───────────────────────────────────────────────────────
const texWood = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#8B6340','#7a5230','#9a7352','#6e4828','#a07848']);
  for (let x = 0; x < w; x += 4) {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(x, 0, 1, h);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.14)';
  ctx.fillRect(0, 0, w, 2);
  ctx.fillRect(0, h - 2, w, 2);
});

// ── Hojas ────────────────────────────────────────────────────────
const texLeaves = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#2d6e1e','#1f5214','#3a7e28','#255c18','#4a8a32']);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = 'rgba(110,210,60,0.28)';
    ctx.fillRect((Math.random() * (w - 2)) | 0, (Math.random() * (h - 2)) | 0, 2, 2);
  }
});

// ── Arena ────────────────────────────────────────────────────────
const texSand = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#DDD06A','#ccc060','#e8da78','#c8b850','#d4ca64']);
  for (let i = 0; i < 22; i++) {
    ctx.fillStyle = 'rgba(90,70,0,0.14)';
    ctx.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 1, 1);
  }
});

// ── Cristal ───────────────────────────────────────────────────────
const texGlass = makeTexture(S, (ctx, w, h) => {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(180,220,242,0.30)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.80)';
  ctx.fillRect(0, 0, w, 1);
  ctx.fillRect(0, 0, 1, h);
  ctx.fillStyle = 'rgba(200,235,255,0.50)';
  ctx.fillRect(0, h - 1, w, 1);
  ctx.fillRect(w - 1, 0, 1, h);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillRect(1, 1, 3, 3);
});

// ── Antorcha ──────────────────────────────────────────────────────
const texTorchStick = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#5a2e0c','#6b3a1f','#4a2008','#7a4828']);
  ctx.fillStyle = 'rgba(255,180,80,0.15)';
  ctx.fillRect((w / 2 - 1) | 0, 0, 2, h);
});

// ═══════════════════════════════════════════════════════════════
//  🧱  GEOMETRÍA Y MATERIALES
//  Orden de caras BoxGeometry: 0:+X  1:-X  2:+Y  3:-Y  4:+Z  5:-Z
//
//  InstancedMesh en Three.js r158 acepta material array igual que
//  Mesh, por lo que MATERIALS.grass (6 materiales diferentes) funciona
//  correctamente sin ninguna adaptación adicional.
// ═══════════════════════════════════════════════════════════════

export const BLOCK_GEO = new THREE.BoxGeometry(1, 1, 1);

export const MATERIALS = {
  grass: [
    new THREE.MeshLambertMaterial({ map: texGrassSide }),
    new THREE.MeshLambertMaterial({ map: texGrassSide }),
    new THREE.MeshLambertMaterial({ map: texGrassTop  }),  // +Y
    new THREE.MeshLambertMaterial({ map: texDirt      }),  // -Y
    new THREE.MeshLambertMaterial({ map: texGrassSide }),
    new THREE.MeshLambertMaterial({ map: texGrassSide }),
  ],
  dirt: Array.from({ length: 6 }, () =>
    new THREE.MeshLambertMaterial({ map: texDirt })),
  stone: Array.from({ length: 6 }, () =>
    new THREE.MeshLambertMaterial({ map: texStone })),
  wood: Array.from({ length: 6 }, () =>
    new THREE.MeshLambertMaterial({ map: texWood })),
  leaves: Array.from({ length: 6 }, () =>
    new THREE.MeshLambertMaterial({ map: texLeaves })),
  sand: Array.from({ length: 6 }, () =>
    new THREE.MeshLambertMaterial({ map: texSand })),
  // transparent + depthWrite:false → Three.js ordena el cristal después
  // de los opacos y no ocluye la geometría detrás de él.
  glass: Array.from({ length: 6 }, () =>
    new THREE.MeshLambertMaterial({
      map: texGlass, transparent: true, opacity: 0.55, depthWrite: false,
    })),
  // Torch: cara +Y es MeshBasicMaterial (auto-iluminada, no depende del sol)
  torch: [
    new THREE.MeshLambertMaterial({ map: texTorchStick }),  // +X
    new THREE.MeshLambertMaterial({ map: texTorchStick }),  // -X
    new THREE.MeshBasicMaterial({ color: 0xffdd33 }),       // +Y llama
    new THREE.MeshLambertMaterial({ color: 0x3a1a04 }),     // -Y base
    new THREE.MeshLambertMaterial({ map: texTorchStick }),  // +Z
    new THREE.MeshLambertMaterial({ map: texTorchStick }),  // -Z
  ],
};

// ═══════════════════════════════════════════════════════════════
//  🗺️  ALMACÉN DEL MUNDO
//  ─────────────────────────────────────────────────────────────
//  blockMap: Map<"x,y,z", BlockData>
//
//  BlockData = {
//    x: number, y: number, z: number,
//    type: string,           — 'grass' | 'dirt' | 'stone' | …
//    normal: {x,y,z}|null,  — normal de colocación (solo antorchas)
//    isSolid: boolean,       — false para glass / leaves / torch
//    mesh?: THREE.Mesh       — solo presente en antorchas
//  }
//
//  CAMBIO DE FASE:
//    Antes: blockMap almacenaba el THREE.Mesh directamente.
//    Ahora: blockMap almacena datos lógicos puros. Los meshes de
//    bloques sólidos viven en los InstancedMeshes del array
//    _instancedMeshes, completamente transparentes al resto del código.
// ═══════════════════════════════════════════════════════════════

export const blockMap = new Map();

// ── Clasificación de tipos ────────────────────────────────────────
// Tipos que NO ocluyen a sus vecinos (no son opacos).
const TRANSPARENT_TYPES = new Set(['glass', 'leaves', 'torch']);

// Tipos renderizados como InstancedMesh (bloques cúbicos 1×1×1).
const INSTANCED_TYPES = ['grass', 'dirt', 'stone', 'wood', 'leaves', 'sand', 'glass'];

// ── Estado interno del renderizador ──────────────────────────────
let _instancedMeshes = [];          // InstancedMeshes activos en _scene
const _matrix = new THREE.Matrix4(); // reutilizado para setMatrixAt (evita GC)

// ── Helpers de acceso O(1) ────────────────────────────────────────
const blockKey = (x, y, z) => `${x},${y},${z}`;
export const hasBlock = (x, y, z) => blockMap.has(blockKey(x, y, z));
export const getBlock = (x, y, z) => blockMap.get(blockKey(x, y, z)) ?? null;

/**
 * Devuelve el tipo (string) del bloque en (x,y,z), o null si no existe.
 * Usado por player.js (colisiones) y por isBlockOccluded (culling).
 * @returns {string|null}
 */
export function getBlockType(x, y, z) {
  const data = blockMap.get(blockKey(x, y, z));
  return data ? data.type : null;
}

// ═══════════════════════════════════════════════════════════════
//  👁️  OCCLUSION CULLING — isBlockOccluded(x, y, z)
//  ─────────────────────────────────────────────────────────────
//  Principio: si las 6 caras de un bloque están cubiertas por
//  vecinos opacos, el bloque es invisible y puede omitirse del
//  InstancedMesh → 0 draw calls, 0 vértices procesados para él.
//
//  "Vecino opaco" = existe en blockMap Y su tipo NO está en
//  TRANSPARENT_TYPES. El aire (celda vacía) expone la cara.
//
//  IMPACTO TÍPICO EN TERRENO PROCEDURAL:
//    Con BASE_HEIGHT=4 y AMPLITUDE=5 la mayoría de los bloques
//    de piedra a Y<2 están totalmente rodeados → se descartan.
//    En un mundo 32×32×9 con ~9000 bloques, normalmente se renderizan
//    solo ~1500–2500 (las capas superficiales), reduciendo los
//    vértices a procesar en GPU en un 70–80%.
// ═══════════════════════════════════════════════════════════════

const NEIGHBOR_OFFSETS = [
  [ 1, 0, 0], [-1, 0, 0],
  [ 0, 1, 0], [ 0,-1, 0],
  [ 0, 0, 1], [ 0, 0,-1],
];

function isBlockOccluded(x, y, z) {
  for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
    const neighbor = blockMap.get(blockKey(x + dx, y + dy, z + dz));
    if (!neighbor)                           return false;  // aire → cara expuesta
    if (TRANSPARENT_TYPES.has(neighbor.type)) return false;  // vecino transparente
  }
  return true;  // todos los 6 vecinos son opacos → bloque oculto
}

// ═══════════════════════════════════════════════════════════════
//  🏗️  rebuildWorldMeshes — Motor de renderizado
//  ─────────────────────────────────────────────────────────────
//  Algoritmo de 5 pasos:
//    1. Eliminar y liberar InstancedMeshes anteriores de la escena
//    2. Contar bloques visibles (no ocultos) por tipo
//    3. Crear un InstancedMesh(geo, mat, count) por tipo
//    4. Rellenar matrices de posición + índice para el Raycaster
//    5. Marcar instanceMatrix.needsUpdate = true
//
//  CUÁNDO SE LLAMA:
//    • Al final de generateDefaultWorld() y deserializeWorld()
//    • Tras addBlock() / removeBlock() (opción rebuild:true, default)
//    • Se puede llamar externamente desde main.js
//
//  NOTA SOBRE DISPOSE:
//    im.dispose() libera únicamente el instanceMatrix buffer en GPU.
//    NO llama dispose() sobre BLOCK_GEO ni MATERIALS porque ambos
//    son singletons del módulo y se reutilizan en cada rebuild.
// ═══════════════════════════════════════════════════════════════

export function rebuildWorldMeshes() {
  if (!_scene) return;

  // ── 1. Limpiar InstancedMeshes anteriores ─────────────────────
  for (const im of _instancedMeshes) {
    _scene.remove(im);
    im.dispose();  // solo libera el instanceMatrix buffer
  }
  _instancedMeshes = [];

  // ── 2. Contar bloques visibles por tipo ────────────────────────
  const counts = Object.fromEntries(INSTANCED_TYPES.map(t => [t, 0]));

  for (const data of blockMap.values()) {
    if (!INSTANCED_TYPES.includes(data.type)) continue;
    if (isBlockOccluded(data.x, data.y, data.z)) continue;
    counts[data.type]++;
  }

  // ── 3. Crear un InstancedMesh por tipo ─────────────────────────
  const meshByType  = {};
  const indexByType = {};

  for (const type of INSTANCED_TYPES) {
    if (counts[type] === 0) continue;

    const im = new THREE.InstancedMesh(BLOCK_GEO, MATERIALS[type], counts[type]);
    im.castShadow    = true;
    im.receiveShadow = true;

    // userData.instances[i] = { x, y, z, type }
    // interaction.js lo lee cuando hit.instanceId !== undefined
    im.userData.instances = new Array(counts[type]);

    meshByType[type]  = im;
    indexByType[type] = 0;

    _scene.add(im);
    _instancedMeshes.push(im);
  }

  // ── 4. Rellenar matrices + metadatos de instancia ──────────────
  for (const data of blockMap.values()) {
    if (!INSTANCED_TYPES.includes(data.type)) continue;
    if (isBlockOccluded(data.x, data.y, data.z)) continue;

    const im  = meshByType[data.type];
    const idx = indexByType[data.type]++;

    _matrix.setPosition(data.x, data.y, data.z);
    im.setMatrixAt(idx, _matrix);

    // Índice lógico para el Raycaster — O(1) lookup en updateRaycaster
    im.userData.instances[idx] = { x: data.x, y: data.y, z: data.z, type: data.type };
  }

  // ── 5. Confirmar en GPU ────────────────────────────────────────
  for (const im of _instancedMeshes) {
    im.instanceMatrix.needsUpdate = true;
  }
}

// ═══════════════════════════════════════════════════════════════
//  📦  getBlockMeshes — lista unificada para el Raycaster
//  ─────────────────────────────────────────────────────────────
//  Devuelve todos los InstancedMeshes activos + las mallas
//  individuales de antorchas.
//  interaction.js pasa esta lista a raycaster.intersectObjects().
// ═══════════════════════════════════════════════════════════════

export function getBlockMeshes() {
  const torchMeshes = [];
  for (const data of blockMap.values()) {
    if (data.mesh) torchMeshes.push(data.mesh);
  }
  return [..._instancedMeshes, ...torchMeshes];
}

// ═══════════════════════════════════════════════════════════════
//  ➕  addBlock
//  ─────────────────────────────────────────────────────────────
//  Para bloques sólidos/transparentes cúbicos:
//    Inserta solo datos lógicos en blockMap. El mesh se genera
//    automáticamente en la siguiente llamada a rebuildWorldMeshes().
//
//  Para antorchas:
//    Crea la malla individual con PointLight (igual que antes),
//    y también guarda datos lógicos en blockMap (con .mesh ref).
//
//  @param {object}  options
//  @param {boolean} options.rebuild
//    true  (default) → llama rebuildWorldMeshes() después de insertar
//    false → no reconstruye; usar durante generación en masa y llamar
//            rebuildWorldMeshes() manualmente una vez al terminar
// ═══════════════════════════════════════════════════════════════

export function addBlock(x, y, z, type = 'grass', normal = null, { rebuild = true } = {}) {
  const key = blockKey(x, y, z);
  if (blockMap.has(key)) return;

  // ── Antorcha: sigue siendo malla individual ────────────────────
  if (type === 'torch') {
    // ════════════════════════════════════════════════════════════
    //  LÓGICA DE COLOCACIÓN DE ANTORCHAS
    //  ─────────────────────────────────────────────────────────
    //  Caras soportadas:
    //    (0,+1, 0) → suelo   : vertical, centrada en la celda
    //    (0,-1, 0) → techo   : PROHIBIDO → return silencioso
    //    (±1, 0, 0) → pared X: inclinada ±30° en eje Z
    //    (0, 0,±1) → pared Z: inclinada ±30° en eje X
    //
    //  MATH pared +X (rotation.z = −π/6):
    //    Δx_llama = +0.3·sin(π/6) = +0.15  (alejándose de pared)
    //    Δy_llama = +0.3·cos(π/6) = +0.26
    //    pos.x_centro = x − 0.5 + 0.15 = x − 0.35
    // ════════════════════════════════════════════════════════════

    if (normal && normal.y === -1) return;  // techo: prohibido

    const TILT     = Math.PI / 6;   // 30°
    const WALL_OFF = 0.35;
    const WALL_Y   = y - 0.15;

    const torchGeo = new THREE.BoxGeometry(0.2, 0.6, 0.2);
    const mesh = new THREE.Mesh(torchGeo, MATERIALS.torch);
    mesh.castShadow    = false;
    mesh.receiveShadow = false;

    let lightX = x, lightY = y + 0.15, lightZ = z;

    if (!normal || normal.y === 1) {
      // Suelo: vertical
      mesh.position.set(x, y - 0.2, z);
      lightX = x;   lightY = y + 0.12;   lightZ = z;

    } else if (normal.x === 1) {
      // Pared +X: inclina cima hacia +X
      mesh.position.set(x - WALL_OFF, WALL_Y, z);
      mesh.rotation.z = -TILT;
      lightX = x - 0.15;   lightY = y + 0.08;

    } else if (normal.x === -1) {
      // Pared -X: inclina cima hacia -X
      mesh.position.set(x + WALL_OFF, WALL_Y, z);
      mesh.rotation.z = TILT;
      lightX = x + 0.15;   lightY = y + 0.08;

    } else if (normal.z === 1) {
      // Pared +Z: llama se aleja hacia +Z
      // rotation.x = +TILT → Z_llama = +0.3·sin(π/6) = +0.15 ✓
      mesh.position.set(x, WALL_Y, z - WALL_OFF);
      mesh.rotation.x = +TILT;
      lightZ = z - 0.20;   lightY = y + 0.10;

    } else if (normal.z === -1) {
      // Pared -Z: llama se aleja hacia -Z
      // rotation.x = -TILT → Z_llama = -0.15 ✓
      mesh.position.set(x, WALL_Y, z + WALL_OFF);
      mesh.rotation.x = -TILT;
      lightZ = z + 0.20;   lightY = y + 0.10;
    }

    // PointLight en la posición aproximada de la llama
    const ptLight = new THREE.PointLight(0xffaa00, 1.5, 12, 1.5);
    ptLight.position.set(lightX, lightY, lightZ);
    _scene.add(ptLight);

    // userData en el mesh para que interaction.js pueda leerlos
    mesh.userData.blockPos   = { x, y, z };
    mesh.userData.blockType  = 'torch';
    mesh.userData.normal     = normal ? { x: normal.x, y: normal.y, z: normal.z } : null;
    mesh.userData.pointLight = ptLight;
    _scene.add(mesh);

    // BlockData incluye referencia al mesh (necesaria en removeBlock)
    const normalPOJO = normal ? { x: normal.x, y: normal.y, z: normal.z } : null;
    blockMap.set(key, { x, y, z, type: 'torch', normal: normalPOJO, isSolid: false, mesh });

    // Una antorcha nueva puede "descubrir" bloques vecinos antes ocultos
    if (rebuild) rebuildWorldMeshes();
    return;
  }

  // ── Bloque cúbico (grass, dirt, stone, wood, leaves, sand, glass) ─
  //  Solo datos lógicos en blockMap. El mesh se crea en rebuildWorldMeshes().
  blockMap.set(key, {
    x, y, z,
    type,
    normal : null,
    isSolid: !TRANSPARENT_TYPES.has(type),
  });

  if (rebuild) rebuildWorldMeshes();
}

// ═══════════════════════════════════════════════════════════════
//  ➖  removeBlock
//  ─────────────────────────────────────────────────────────────
//  @param {object}  options
//  @param {boolean} options.rebuild — igual que en addBlock
// ═══════════════════════════════════════════════════════════════

export function removeBlock(x, y, z, { rebuild = true } = {}) {
  const data = blockMap.get(blockKey(x, y, z));
  if (!data) return;

  // Si es antorcha: limpiar mesh individual y PointLight
  if (data.mesh) {
    if (data.mesh.userData.pointLight) {
      _scene.remove(data.mesh.userData.pointLight);
      data.mesh.userData.pointLight.dispose?.();
      data.mesh.userData.pointLight = null;
    }
    _scene.remove(data.mesh);
    // Liberar geometría única de la antorcha (distinta a BLOCK_GEO)
    data.mesh.geometry.dispose();
  }

  blockMap.delete(blockKey(x, y, z));
  if (rebuild) rebuildWorldMeshes();
}

// ═══════════════════════════════════════════════════════════════
//  🌍  GENERACIÓN PROCEDURAL DE TERRENO — Simplex Noise
//  ─────────────────────────────────────────────────────────────
//  PARÁMETROS DE TOPOGRAFÍA:
//
//    SCALE (suavidad de colinas):
//      Alto (>30) → colinas anchas y suaves.  Bajo (<10) → abrupto.
//      ► Rango recomendado: 15–40.
//
//    AMPLITUDE (rango de alturas en bloques):
//      noise2D devuelve [-1,+1] → altura final ∈ [BASE-AMP, BASE+AMP].
//      Alto (>8) → montañas.  Bajo (<3) → terreno casi plano.
//      ► Rango recomendado: 3–12.
//
//    BASE_HEIGHT:
//      Con BASE_HEIGHT=4 y AMPLITUDE=5 el rango es [-1, +9].
//
//  CAPAS GEOLÓGICAS:
//    y == maxY          → grass
//    maxY-2 <= y < maxY → dirt   (2 bloques de transición)
//    y < maxY-2         → stone  (núcleo)
//
//  OPTIMIZACIÓN:
//    Usa { rebuild: false } en addBlock para NO llamar
//    rebuildWorldMeshes() en cada uno de los ~9000 bloques.
//    El único rebuild se hace al final, en O(n) total.
// ═══════════════════════════════════════════════════════════════

export function generateDefaultWorld() {
  const noise2D = createNoise2D();   // semilla aleatoria cada vez

  const SCALE       = 22;
  const AMPLITUDE   = 5;
  const BASE_HEIGHT = 4;
  const N           = CONFIG.WORLD_SIZE;

  for (let x = 0; x < N; x++) {
    for (let z = 0; z < N; z++) {
      const noiseVal = noise2D(x / SCALE, z / SCALE);
      const maxY     = Math.round(noiseVal * AMPLITUDE) + BASE_HEIGHT;

      for (let y = 0; y <= maxY; y++) {
        let type;
        if      (y === maxY)       type = 'grass';
        else if (y >= maxY - 2)    type = 'dirt';
        else                       type = 'stone';

        addBlock(x, y, z, type, null, { rebuild: false });
      }
    }
  }

  // Un solo rebuild tras insertar todos los bloques
  rebuildWorldMeshes();
}

// Alias de compatibilidad (por si algún módulo importa generateWorld)
export const generateWorld = generateDefaultWorld;

// ═══════════════════════════════════════════════════════════════
//  💾  SERIALIZACIÓN / DESERIALIZACIÓN
//  ─────────────────────────────────────────────────────────────
//  Formato: "x,y,z:tipo"             (bloques sólidos, antorcha suelo)
//           "x,y,z:tipo:nx,ny,nz"    (antorcha en pared)
//
//  serializeWorld() lee de BlockData (ya no de mesh.userData).
//  deserializeWorld() usa addBlock({ rebuild:false }) en masa
//  y llama rebuildWorldMeshes() una sola vez al final.
// ═══════════════════════════════════════════════════════════════

/**
 * @returns {string[]}  ej. ["0,0,0:grass", "5,1,3:torch:1,0,0"]
 */
export function serializeWorld() {
  const result = [];
  for (const [key, data] of blockMap) {
    const type   = data.type;
    const n      = data.normal;
    // Componentes de la normal son siempre -1, 0 o 1 → sin decimales
    const suffix = n ? `:${n.x},${n.y},${n.z}` : '';
    result.push(`${key}:${type}${suffix}`);
  }
  return result;
}

/**
 * Restaura el mundo desde string[].
 * @param {string[]} blocksArray — [] limpia el mundo sin cargar nada
 */
export function deserializeWorld(blocksArray) {
  // ── Paso 1: vaciar el mundo actual ──────────────────────────────
  //  Copia las claves antes de iterar porque removeBlock modifica
  //  blockMap en el mismo bucle.
  const keysToRemove = Array.from(blockMap.keys());
  for (const key of keysToRemove) {
    const data = blockMap.get(key);
    // BlockData tiene {x, y, z} directamente (antes era mesh.userData.blockPos)
    removeBlock(data.x, data.y, data.z, { rebuild: false });
  }

  // ── Paso 2: reconstruir desde el array serializado ───────────────
  for (const entry of blocksArray) {
    const parts = entry.split(':');
    if (parts.length < 2) continue;

    const coords = parts[0].split(',');
    const type   = parts[1];
    const x = Number(coords[0]);
    const y = Number(coords[1]);
    const z = Number(coords[2]);
    if (isNaN(x) || isNaN(y) || isNaN(z) || !type) continue;

    let normal = null;
    if (parts[2]) {
      const nc = parts[2].split(',');
      if (nc.length === 3) {
        const nx = Number(nc[0]), ny = Number(nc[1]), nz = Number(nc[2]);
        if (!isNaN(nx) && !isNaN(ny) && !isNaN(nz)) {
          // THREE.Vector3 para compatibilidad con addBlock (antorchas)
          normal = new THREE.Vector3(nx, ny, nz);
        }
      }
    }

    addBlock(x, y, z, type, normal, { rebuild: false });
  }

  // ── Paso 3: un único rebuild ─────────────────────────────────────
  rebuildWorldMeshes();
}