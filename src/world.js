// ═══════════════════════════════════════════════════════════════
//  src/world.js  —  VibeCraft · Fase 3: Sistema de Chunks
//
//  ARQUITECTURA DE ESTA FASE:
//  ─────────────────────────────────────────────────────────────
//  ANTES  │  generateDefaultWorld() → terreno fijo 32×32
//         │  El mundo entero existía en memoria desde el inicio.
//
//  AHORA  │  updateChunks(playerX, playerZ) — llamar cada frame
//         │  Carga chunks nuevos dentro de RENDER_DISTANCE.
//         │  Descarga chunks que quedan fuera del rango.
//         │  La carga es incremental: solo chunks no generados aún.
//
//  CHUNK KEY: "cx,cz"  donde cx = floor(x / CHUNK_SIZE)
//             Un chunk cubre bloques [cx*CS .. (cx+1)*CS-1] en X/Z.
//
//  NOISE2D:
//    Instancia única por mundo (resetChunks() la regenera).
//    Garantiza terreno seamless entre chunks adyacentes.
//    Mismas coords mundiales → mismos valores de ruido.
//
//  InstancedMesh + Occlusion Culling: sin cambios vs fase anterior.
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';
import { CONFIG } from './config.js';
import { createNoise2D } from 'https://unpkg.com/simplex-noise@4.0.1/dist/esm/simplex-noise.js';

let _scene = null;
export function initWorld(scene) { _scene = scene; }

// ═══════════════════════════════════════════════════════════════
//  HELPERS DE TEXTURA
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

const texGrassTop = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#5d8a3c','#4a7a2b','#6a9a49','#52803a','#3d6a2b']);
});
const texGrassSide = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#8B5E3C','#7a4d2b','#9a6e4c','#6a3d1c']);
  noiseFill(ctx, 0, 0, w, 4, ['#5d8a3c','#4a7a2b','#6a9a49','#52803a']);
});
const texDirt = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#8B5E3C','#7a4d2b','#9a6e4c','#6a3d1c','#a07040']);
});
const texStone = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#888','#7a7a7a','#969696','#6e6e6e','#a0a0a0']);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = '#505050';
    ctx.fillRect((Math.random() * (w - 1)) | 0, (Math.random() * (h - 2)) | 0, 1, 2);
  }
});
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
const texLeaves = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#2d6e1e','#1f5214','#3a7e28','#255c18','#4a8a32']);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = 'rgba(110,210,60,0.28)';
    ctx.fillRect((Math.random() * (w - 2)) | 0, (Math.random() * (h - 2)) | 0, 2, 2);
  }
});
const texSand = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#DDD06A','#ccc060','#e8da78','#c8b850','#d4ca64']);
  for (let i = 0; i < 22; i++) {
    ctx.fillStyle = 'rgba(90,70,0,0.14)';
    ctx.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 1, 1);
  }
});
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
const texTorchStick = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#5a2e0c','#6b3a1f','#4a2008','#7a4828']);
  ctx.fillStyle = 'rgba(255,180,80,0.15)';
  ctx.fillRect((w / 2 - 1) | 0, 0, 2, h);
});

// ═══════════════════════════════════════════════════════════════
//  GEOMETRIA Y MATERIALES
// ═══════════════════════════════════════════════════════════════

export const BLOCK_GEO = new THREE.BoxGeometry(1, 1, 1);

export const MATERIALS = {
  grass: [
    new THREE.MeshLambertMaterial({ map: texGrassSide }),
    new THREE.MeshLambertMaterial({ map: texGrassSide }),
    new THREE.MeshLambertMaterial({ map: texGrassTop  }),
    new THREE.MeshLambertMaterial({ map: texDirt      }),
    new THREE.MeshLambertMaterial({ map: texGrassSide }),
    new THREE.MeshLambertMaterial({ map: texGrassSide }),
  ],
  dirt:   Array.from({ length: 6 }, () => new THREE.MeshLambertMaterial({ map: texDirt   })),
  stone:  Array.from({ length: 6 }, () => new THREE.MeshLambertMaterial({ map: texStone  })),
  wood:   Array.from({ length: 6 }, () => new THREE.MeshLambertMaterial({ map: texWood   })),
  leaves: Array.from({ length: 6 }, () => new THREE.MeshLambertMaterial({ map: texLeaves })),
  sand:   Array.from({ length: 6 }, () => new THREE.MeshLambertMaterial({ map: texSand   })),
  glass:  Array.from({ length: 6 }, () => new THREE.MeshLambertMaterial({
    map: texGlass, transparent: true, opacity: 0.55, depthWrite: false,
  })),
  torch: [
    new THREE.MeshLambertMaterial({ map: texTorchStick }),
    new THREE.MeshLambertMaterial({ map: texTorchStick }),
    new THREE.MeshBasicMaterial  ({ color: 0xffdd33    }),
    new THREE.MeshLambertMaterial({ color: 0x3a1a04    }),
    new THREE.MeshLambertMaterial({ map: texTorchStick }),
    new THREE.MeshLambertMaterial({ map: texTorchStick }),
  ],
};

// ═══════════════════════════════════════════════════════════════
//  ALMACEN DEL MUNDO
// ═══════════════════════════════════════════════════════════════

export const blockMap = new Map();

const TRANSPARENT_TYPES = new Set(['glass', 'leaves', 'torch']);
const INSTANCED_TYPES   = ['grass', 'dirt', 'stone', 'wood', 'leaves', 'sand', 'glass'];

let _instancedMeshes = [];
const _matrix = new THREE.Matrix4();

const blockKey = (x, y, z) => `${x},${y},${z}`;
const chunkKey = (cx, cz)   => `${cx},${cz}`;

export const hasBlock = (x, y, z) => blockMap.has(blockKey(x, y, z));
export const getBlock = (x, y, z) => blockMap.get(blockKey(x, y, z)) ?? null;

export function getBlockType(x, y, z) {
  const data = blockMap.get(blockKey(x, y, z));
  return data ? data.type : null;
}

// ═══════════════════════════════════════════════════════════════
//  ESTADO DEL SISTEMA DE CHUNKS
//  ─────────────────────────────────────────────────────────────
//  _noise2D          — instancia Simplex compartida por todos los
//                      chunks del mundo. Nueva instancia = nuevo terreno.
//  _generatedChunks  — Set<"cx,cz"> de chunks ya generados.
//                      Evita regenerar el mismo chunk dos veces.
//  _lastChunkX/Z     — chunk del jugador en el frame anterior.
//                      updateChunks() es no-op si no cambia.
// ═══════════════════════════════════════════════════════════════

let _noise2D           = createNoise2D();
const _generatedChunks = new Set();
let _lastChunkX        = null;
let _lastChunkZ        = null;

/**
 * resetChunks — Reinicia el sistema de chunks para un mundo nuevo.
 *   • Crea una nueva instancia de noise2D (semilla aleatoria).
 *   • Vacía el registro de chunks generados.
 *   • Fuerza recalculo completo en el próximo updateChunks().
 */
export function resetChunks() {
  _noise2D = createNoise2D();
  _generatedChunks.clear();
  _lastChunkX = null;
  _lastChunkZ = null;
}

// ═══════════════════════════════════════════════════════════════
//  OCCLUSION CULLING
// ═══════════════════════════════════════════════════════════════

const NEIGHBOR_OFFSETS = [
  [ 1, 0, 0], [-1, 0, 0],
  [ 0, 1, 0], [ 0,-1, 0],
  [ 0, 0, 1], [ 0, 0,-1],
];

function isBlockOccluded(x, y, z) {
  for (const [dx, dy, dz] of NEIGHBOR_OFFSETS) {
    const n = blockMap.get(blockKey(x + dx, y + dy, z + dz));
    if (!n || TRANSPARENT_TYPES.has(n.type)) return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════
//  rebuildWorldMeshes
// ═══════════════════════════════════════════════════════════════

export function rebuildWorldMeshes() {
  if (!_scene) return;

  for (const im of _instancedMeshes) {
    _scene.remove(im);
    im.dispose();
  }
  _instancedMeshes = [];

  const counts = Object.fromEntries(INSTANCED_TYPES.map(t => [t, 0]));
  for (const data of blockMap.values()) {
    if (!INSTANCED_TYPES.includes(data.type)) continue;
    // Culling de distancia: bloques fuera del radio no van a la GPU
    // pero permanecen en blockMap (separacion RAM / VRAM).
    const bCx = Math.floor(data.x / CONFIG.CHUNK_SIZE);
    const bCz = Math.floor(data.z / CONFIG.CHUNK_SIZE);
    if (_lastChunkX !== null && (
      Math.abs(bCx - _lastChunkX) > CONFIG.RENDER_DISTANCE ||
      Math.abs(bCz - _lastChunkZ) > CONFIG.RENDER_DISTANCE
    )) continue;
    if (isBlockOccluded(data.x, data.y, data.z)) continue;
    counts[data.type]++;
  }

  const meshByType  = {};
  const indexByType = {};
  for (const type of INSTANCED_TYPES) {
    if (counts[type] === 0) continue;
    const im = new THREE.InstancedMesh(BLOCK_GEO, MATERIALS[type], counts[type]);
    im.castShadow = im.receiveShadow = true;
    im.userData.instances = new Array(counts[type]);
    meshByType[type]  = im;
    indexByType[type] = 0;
    _scene.add(im);
    _instancedMeshes.push(im);
  }

  for (const data of blockMap.values()) {
    if (!INSTANCED_TYPES.includes(data.type)) continue;
    const bCx = Math.floor(data.x / CONFIG.CHUNK_SIZE);
    const bCz = Math.floor(data.z / CONFIG.CHUNK_SIZE);
    if (_lastChunkX !== null && (
      Math.abs(bCx - _lastChunkX) > CONFIG.RENDER_DISTANCE ||
      Math.abs(bCz - _lastChunkZ) > CONFIG.RENDER_DISTANCE
    )) continue;
    if (isBlockOccluded(data.x, data.y, data.z)) continue;
    const im  = meshByType[data.type];
    const idx = indexByType[data.type]++;
    _matrix.setPosition(data.x, data.y, data.z);
    im.setMatrixAt(idx, _matrix);
    im.userData.instances[idx] = { x: data.x, y: data.y, z: data.z, type: data.type };
  }

  for (const im of _instancedMeshes) im.instanceMatrix.needsUpdate = true;
}

// ═══════════════════════════════════════════════════════════════
//  getBlockMeshes
// ═══════════════════════════════════════════════════════════════

export function getBlockMeshes() {
  const torchMeshes = [];
  for (const data of blockMap.values()) {
    if (data.mesh) torchMeshes.push(data.mesh);
  }
  return [..._instancedMeshes, ...torchMeshes];
}

// ═══════════════════════════════════════════════════════════════
//  addBlock
// ═══════════════════════════════════════════════════════════════

export function addBlock(x, y, z, type = 'grass', normal = null, { rebuild = true } = {}) {
  const key = blockKey(x, y, z);
  if (blockMap.has(key)) return;

  if (type === 'torch') {
    if (normal && normal.y === -1) return;

    const TILT = Math.PI / 6, WALL_OFF = 0.35, WALL_Y = y - 0.15;
    const torchGeo = new THREE.BoxGeometry(0.2, 0.6, 0.2);
    const mesh = new THREE.Mesh(torchGeo, MATERIALS.torch);
    mesh.castShadow = mesh.receiveShadow = false;

    let lightX = x, lightY = y + 0.15, lightZ = z;

    if (!normal || normal.y === 1) {
      mesh.position.set(x, y - 0.2, z);
      lightX = x; lightY = y + 0.12; lightZ = z;
    } else if (normal.x === 1) {
      mesh.position.set(x - WALL_OFF, WALL_Y, z);
      mesh.rotation.z = -TILT;
      lightX = x - 0.15; lightY = y + 0.08;
    } else if (normal.x === -1) {
      mesh.position.set(x + WALL_OFF, WALL_Y, z);
      mesh.rotation.z = TILT;
      lightX = x + 0.15; lightY = y + 0.08;
    } else if (normal.z === 1) {
      mesh.position.set(x, WALL_Y, z - WALL_OFF);
      mesh.rotation.x = +TILT;
      lightZ = z - 0.20; lightY = y + 0.10;
    } else if (normal.z === -1) {
      mesh.position.set(x, WALL_Y, z + WALL_OFF);
      mesh.rotation.x = -TILT;
      lightZ = z + 0.20; lightY = y + 0.10;
    }

    const ptLight = new THREE.PointLight(0xffaa00, 1.5, 12, 1.5);
    ptLight.position.set(lightX, lightY, lightZ);
    _scene.add(ptLight);

    mesh.userData.blockPos   = { x, y, z };
    mesh.userData.blockType  = 'torch';
    mesh.userData.normal     = normal ? { x: normal.x, y: normal.y, z: normal.z } : null;
    mesh.userData.pointLight = ptLight;
    _scene.add(mesh);

    blockMap.set(key, {
      x, y, z,
      type  : 'torch',
      normal: normal ? { x: normal.x, y: normal.y, z: normal.z } : null,
      isSolid: false,
      mesh,
    });

    if (rebuild) rebuildWorldMeshes();
    return;
  }

  blockMap.set(key, {
    x, y, z,
    type,
    normal : null,
    isSolid: !TRANSPARENT_TYPES.has(type),
  });

  if (rebuild) rebuildWorldMeshes();
}

// ═══════════════════════════════════════════════════════════════
//  removeBlock
// ═══════════════════════════════════════════════════════════════

export function removeBlock(x, y, z, { rebuild = true } = {}) {
  const data = blockMap.get(blockKey(x, y, z));
  if (!data) return;

  if (data.mesh) {
    if (data.mesh.userData.pointLight) {
      _scene.remove(data.mesh.userData.pointLight);
      data.mesh.userData.pointLight.dispose?.();
      data.mesh.userData.pointLight = null;
    }
    _scene.remove(data.mesh);
    data.mesh.geometry.dispose();
  }

  blockMap.delete(blockKey(x, y, z));
  if (rebuild) rebuildWorldMeshes();
}

// ═══════════════════════════════════════════════════════════════
//  updateChunks — Motor de streaming de terreno
//  ─────────────────────────────────────────────────────────────
//  Llamar cada frame desde animate() pasando la posición del jugador.
//
//  ALGORITMO:
//    1. Calcular chunk actual del jugador (cx, cz).
//    2. Si no cambió de chunk → return (no-op).
//    3. Construir Set de chunks "deseados" dentro del radio RD.
//    4. Para cada chunk deseado NO generado → _generateChunk().
//    5. Para cada bloque en blockMap cuyo chunk quede fuera del
//       radio → removeBlock({rebuild:false}) + eliminar de
//       _generatedChunks (para poder regenerar al volver).
//    6. Un único rebuildWorldMeshes() al final.
// ═══════════════════════════════════════════════════════════════

export function updateChunks(playerX, playerZ) {
  const CS = CONFIG.CHUNK_SIZE;
  const RD = CONFIG.RENDER_DISTANCE;

  // 1. Chunk actual del jugador
  const cx = Math.floor(playerX / CS);
  const cz = Math.floor(playerZ / CS);

  // 2. Early-exit si no cambió de chunk
  if (cx === _lastChunkX && cz === _lastChunkZ) return;
  _lastChunkX = cx;
  _lastChunkZ = cz;

  // 3. Conjunto de chunks deseados
  const desiredChunks = new Set();
  for (let dx = -RD; dx <= RD; dx++) {
    for (let dz = -RD; dz <= RD; dz++) {
      desiredChunks.add(chunkKey(cx + dx, cz + dz));
    }
  }

  // 4. Generar chunks nuevos (rebuild:false en cada addBlock).
  //    Los bloques fuera del radio NO se eliminan del blockMap:
  //    persisten en RAM. rebuildWorldMeshes() aplica culling de
  //    distancia para excluirlos de la GPU sin borrarlos.
  for (const key of desiredChunks) {
    if (_generatedChunks.has(key)) continue;
    const [ocx, ocz] = key.split(',').map(Number);
    _generateChunk(ocx, ocz);
    _generatedChunks.add(key);
  }

  // 5. Rebuild unico — siempre al cambiar de chunk para actualizar
  //    el culling de distancia aunque no haya chunks nuevos.
  rebuildWorldMeshes();
}

// ── _generateChunk (interno) ──────────────────────────────────────
//  Genera las columnas de terreno de un chunk usando _noise2D.
//  Usa addBlock({rebuild:false}) en masa para evitar rebuildWorldMeshes
//  por cada bloque; el rebuild se delega a updateChunks().

function _generateChunk(cx, cz) {
  const CS     = CONFIG.CHUNK_SIZE;
  const xStart = cx * CS, xEnd = xStart + CS;
  const zStart = cz * CS, zEnd = zStart + CS;

  for (let x = xStart; x < xEnd; x++) {
    for (let z = zStart; z < zEnd; z++) {
      // Fractal Brownian Motion — 3 octavas de ruido
      //   n1: formas masivas (continentes, valles amplios)  escala 100
      //   n2: colinas locales de escala media               escala  30
      //   n3: detalles finos de superficie                  escala  10
      const n1 = _noise2D(x / 100, z / 100);
      const n2 = _noise2D(x / 30,  z / 30);
      const n3 = _noise2D(x / 10,  z / 10);

      // Combinar con pesos decrecientes (n1 define la forma, n3 da textura)
      let elevation = (n1 * 0.60) + (n2 * 0.30) + (n3 * 0.10);

      // Exponenciacion: aplana valles y agudiza picos de montana
      if (elevation > 0) {
        elevation = Math.pow(elevation, 1.4);
      }

      // Mapear al rango de alturas: max ~27, base 5
      const maxY = Math.max(0, Math.round(elevation * 22) + 5);

      for (let y = 0; y <= maxY; y++) {
        let type;
        if      (y === maxY)    type = 'grass';
        else if (y >= maxY - 2) type = 'dirt';
        else                    type = 'stone';
        addBlock(x, y, z, type, null, { rebuild: false });
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  SERIALIZACION / DESERIALIZACION
// ═══════════════════════════════════════════════════════════════

export function serializeWorld() {
  const result = [];
  for (const [key, data] of blockMap) {
    const n      = data.normal;
    const suffix = n ? `:${n.x},${n.y},${n.z}` : '';
    result.push(`${key}:${data.type}${suffix}`);
  }
  return result;
}

export function deserializeWorld(blocksArray) {
  // Paso 1: vaciar el mundo actual
  for (const key of Array.from(blockMap.keys())) {
    const data = blockMap.get(key);
    removeBlock(data.x, data.y, data.z, { rebuild: false });
  }

  // Resetear estado de chunks para la nueva sesión
  _generatedChunks.clear();
  _lastChunkX = null;
  _lastChunkZ = null;

  // Paso 2: reconstruir desde el array serializado
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
        if (!isNaN(nx) && !isNaN(ny) && !isNaN(nz))
          normal = new THREE.Vector3(nx, ny, nz);
      }
    }

    addBlock(x, y, z, type, normal, { rebuild: false });
  }

  // Paso 3: registrar en _generatedChunks los chunks presentes
  //  → updateChunks() no regenerará terreno encima de bloques cargados
  const CS = CONFIG.CHUNK_SIZE;
  for (const data of blockMap.values()) {
    _generatedChunks.add(chunkKey(
      Math.floor(data.x / CS),
      Math.floor(data.z / CS),
    ));
  }

  // Paso 4: rebuild único
  rebuildWorldMeshes();
}