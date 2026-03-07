// ═══════════════════════════════════════════════════════════════
//  src/world.js
//  Responsabilidades:
//    • Texturas procedurales (Canvas 2D, sin CORS)
//    • Geometría y materiales compartidos de bloques
//    • Almacén del mundo: blockMap (Map<"x,y,z", Mesh>)
//    • CRUD de bloques: addBlock / removeBlock / hasBlock / getBlock
//    • Cache de meshes para el Raycaster
//    • Generación del terreno plano inicial
//
//  NOTA: addBlock necesita la referencia a la `scene` de Three.js.
//  Se la pasamos al llamar a initWorld(scene) antes de generateWorld().
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { CONFIG } from './config.js';

// ── Referencia a la escena (se inyecta desde main.js via initWorld) ──
let _scene = null;

/**
 * Inicializa el módulo de mundo inyectando la escena Three.js.
 * Debe llamarse UNA sola vez antes de cualquier addBlock / generateWorld.
 * @param {THREE.Scene} scene
 */
export function initWorld(scene) {
  _scene = scene;
}

// ═══════════════════════════════════════════════════════════════
//  🎨  TEXTURAS PROCEDURALES
//  ─────────────────────────────────────────────────────────────
//  Se generan en Canvas 2D de 16×16 con ruido por píxel.
//  NearestFilter preserva el aspecto pixelado (igual que Minecraft).
//  Al no cargar ningún archivo externo no existe riesgo de CORS.
// ═══════════════════════════════════════════════════════════════

/**
 * Crea una THREE.CanvasTexture con filtrado pixelado (NearestFilter).
 * @param {number}   size — Resolución del canvas (NxN píxeles)
 * @param {Function} fn   — (ctx, width, height) => void  (función de dibujo)
 * @returns {THREE.CanvasTexture}
 */
function makeTexture(size, fn) {
  const canvas = document.createElement('canvas');
  canvas.width  = size;
  canvas.height = size;
  fn(canvas.getContext('2d'), size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;               // aspecto pixelado al acercar
  tex.minFilter = THREE.NearestMipmapNearestFilter;  // mipmap pixelado al alejar
  return tex;
}

/**
 * Rellena un rectángulo del canvas píxel a píxel usando colores aleatorios
 * de la paleta dada. Genera la apariencia de ruido granular estilo pixel-art.
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x0, y0 — Origen del rectángulo
 * @param {number} w,  h  — Dimensiones del rectángulo
 * @param {string[]} palette — Array de colores CSS
 */
function noiseFill(ctx, x0, y0, w, h, palette) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      ctx.fillStyle = palette[(Math.random() * palette.length) | 0];
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

const TEX_SIZE = 16; // Resolución estándar Minecraft

// Cara superior de hierba (solo verde variado)
const texGrassTop = makeTexture(TEX_SIZE, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#5d8a3c', '#4a7a2b', '#6a9a49', '#52803a', '#3d6a2b']);
});

// Cara lateral de hierba: tierra con franja verde superior.
// ACLARACIÓN flipY: Three.js voltea el canvas verticalmente al crear la textura,
// así que la franja que pintamos en las últimas 4 filas del canvas (parte baja)
// aparecerá en la PARTE ALTA de la cara 3D → justo la franja de hierba.
const texGrassSide = makeTexture(TEX_SIZE, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#8B5E3C', '#7a4d2b', '#9a6e4c', '#6a3d1c']);         // tierra
  noiseFill(ctx, 0, h - 4, w, 4, ['#5d8a3c', '#4a7a2b', '#6a9a49']);                // franja hierba
});

// Cara de tierra pura
const texDirt = makeTexture(TEX_SIZE, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#8B5E3C', '#7a4d2b', '#9a6e4c', '#6a3d1c', '#a07040']);
});

// ═══════════════════════════════════════════════════════════════
//  🧱  GEOMETRÍA Y MATERIALES
//  ─────────────────────────────────────────────────────────────
//  Una sola BoxGeometry compartida por todos los bloques.
//  Orden de caras en BoxGeometry:
//    0: +X (derecha)  |  1: -X (izquierda)
//    2: +Y (arriba)   |  3: -Y (abajo)
//    4: +Z (frente)   |  5: -Z (atrás)
// ═══════════════════════════════════════════════════════════════

export const BLOCK_GEO = new THREE.BoxGeometry(1, 1, 1);

export const MATERIALS = {
  grass: [
    new THREE.MeshLambertMaterial({ map: texGrassSide }),  // +X
    new THREE.MeshLambertMaterial({ map: texGrassSide }),  // -X
    new THREE.MeshLambertMaterial({ map: texGrassTop  }),  // +Y ← cima
    new THREE.MeshLambertMaterial({ map: texDirt      }),  // -Y ← base
    new THREE.MeshLambertMaterial({ map: texGrassSide }),  // +Z
    new THREE.MeshLambertMaterial({ map: texGrassSide }),  // -Z
  ],
  dirt: Array.from({ length: 6 }, () =>
    new THREE.MeshLambertMaterial({ map: texDirt })
  ),
};

// ═══════════════════════════════════════════════════════════════
//  🗺️  ALMACÉN DEL MUNDO
//  ─────────────────────────────────────────────────────────────
//  Map<"x,y,z", THREE.Mesh>  →  búsqueda, inserción y
//  eliminación en O(1), sin iterar arrays.
// ═══════════════════════════════════════════════════════════════

export const blockMap = new Map();

// Cache invalidable de meshes para el Raycaster.
// Se reconstruye solo cuando el mundo cambia (cacheDirty = true).
let meshCache  = [];
let cacheDirty = true;

// ── Helpers de clave ────────────────────────────────────────────
const blockKey = (x, y, z) => `${x},${y},${z}`;

/** Devuelve true si existe un bloque en las coordenadas dadas. */
export const hasBlock = (x, y, z) => blockMap.has(blockKey(x, y, z));

/** Devuelve el Mesh del bloque o null si no existe. */
export const getBlock = (x, y, z) => blockMap.get(blockKey(x, y, z)) ?? null;

// ── CRUD ────────────────────────────────────────────────────────

/**
 * Añade un bloque a la escena y al mapa del mundo.
 * No hace nada si ya existe un bloque en (x, y, z).
 * @param {number} x, y, z — Coordenadas enteras del bloque
 * @param {'grass'|'dirt'} type — Tipo de bloque
 */
export function addBlock(x, y, z, type = 'grass') {
  const key = blockKey(x, y, z);
  if (blockMap.has(key)) return;

  const mesh = new THREE.Mesh(BLOCK_GEO, MATERIALS[type] ?? MATERIALS.dirt);
  mesh.position.set(x, y, z);
  mesh.castShadow    = true;
  mesh.receiveShadow = true;
  // userData permite recuperar coords del bloque desde un hit del Raycaster
  mesh.userData = { blockPos: { x, y, z }, blockType: type };

  _scene.add(mesh);
  blockMap.set(key, mesh);
  cacheDirty = true;  // ← invalidar cache del Raycaster
}

/**
 * Elimina un bloque de la escena y del mapa del mundo.
 * No hace nada si no existe.
 * @param {number} x, y, z
 */
export function removeBlock(x, y, z) {
  const mesh = blockMap.get(blockKey(x, y, z));
  if (!mesh) return;
  _scene.remove(mesh);
  blockMap.delete(blockKey(x, y, z));
  cacheDirty = true;  // ← invalidar cache del Raycaster
}

/**
 * Devuelve el array de meshes para el Raycaster.
 * Regenera el array solo cuando cacheDirty === true (mundo modificado),
 * evitando allocations innecesarias en el hot loop a 60 fps.
 * @returns {THREE.Mesh[]}
 */
export function getBlockMeshes() {
  if (cacheDirty) {
    meshCache  = Array.from(blockMap.values());
    cacheDirty = false;
  }
  return meshCache;
}

// ═══════════════════════════════════════════════════════════════
//  🌍  GENERACIÓN DEL MUNDO
// ═══════════════════════════════════════════════════════════════

/**
 * Genera el terreno plano inicial de WORLD_SIZE × WORLD_SIZE bloques
 * de hierba en la capa Y = 0.
 */
export function generateWorld() {
  const N = CONFIG.WORLD_SIZE;
  for (let x = 0; x < N; x++) {
    for (let z = 0; z < N; z++) {
      addBlock(x, 0, z, 'grass');
    }
  }
}