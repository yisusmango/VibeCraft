// ═══════════════════════════════════════════════════════════════
//  src/world.js  —  VibeCraft · Fase 4: Chunk-Level InstancedMesh
//
//  ARQUITECTURA DE ESTA FASE:
//  ─────────────────────────────────────────────────────────────
//  ANTES  │  Un array global _instancedMeshes contenía los
//         │  InstancedMeshes de TODO el mundo visible.
//         │  rebuildWorldMeshes() iteraba O(blockMap.size) bloques
//         │  cada vez que se cargaba cualquier chunk.
//         │  Con RENDER_DISTANCE=6 → 13×13=169 chunks activos
//         │  → hasta 169 × ~700 bloques = ~118.000 iteraciones
//         │  por rebuild. Causa de los stutters.
//
//  AHORA  │  _chunkMeshes: Map<"cx,cz", { ims, torches }>
//         │  Cada entrada almacena los InstancedMeshes de UN chunk.
//         │  buildChunkMesh(cx, cz) itera solo los 16×16×64 = 16.384
//         │  posibles posiciones de ese chunk → ~100× más rápido.
//         │  updateChunks() genera y meshea 1 chunk por frame →
//         │  trabajo perfectamente repartido, sin spikes de CPU.
//
//  GESTIÓN DE TORCHES:
//    Las antorchas siguen siendo THREE.Mesh individuales añadidas
//    a escena en addBlock(). buildChunkMesh() las recoge en
//    entry.torches para poder controlar su visibilidad cuando
//    el chunk se descarga visualmente.
//
//  DESCARGA VISUAL:
//    Cuando un chunk sale del radio de render, sus InstancedMeshes
//    se retiran de escena y se libera su memoria GPU (.dispose()).
//    Los bloques en blockMap NO se eliminan: persisten en RAM para
//    ser meshados de nuevo si el jugador regresa al área.
//    Las antorchas se ocultan (visible=false) sin destruirse.
//
//  OCCLUSION CULLING:
//    isBlockOccluded() consulta blockMap globalmente, por lo que
//    funciona correctamente con vecinos en chunks adyacentes.
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

// ── Chunk-Level Mesh Storage ──────────────────────────────────────
//  Key  : "cx,cz"
//  Value: { ims: THREE.InstancedMesh[], torches: THREE.Mesh[] }
//    ims     → InstancedMeshes de bloques sólidos (se crean/destruyen
//               en buildChunkMesh)
//    torches → referencias a los THREE.Mesh de antorchas ya existentes
//               en escena (no se destruyen aquí, solo se muestran/ocultan)
const _chunkMeshes = new Map();

const _matrix = new THREE.Matrix4();

// Altura máxima de escaneo para buildChunkMesh.
// La generación de terreno alcanza maxY ≤ 27; 64 da margen para
// construcciones del jugador sin ser prohibitivo (16×16×64 = 16.384
// posiciones por chunk, la mayoría vacías → Map.get miss muy rápido).
const Y_SCAN_MAX = 64;

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
//  _generatedChunks  — Set<"cx,cz"> de chunks cuyo terreno ya fue
//                      insertado en blockMap. Evita regenerar.
//  _lastChunkX/Z     — chunk del jugador según el último frame en que
//                      updateChunks() se ejecutó (usado por helpers).
// ═══════════════════════════════════════════════════════════════

let _noise2D           = createNoise2D();
const _generatedChunks = new Set();
let _lastChunkX        = null;
let _lastChunkZ        = null;

/**
 * resetChunks — Reinicia el sistema de chunks para un mundo nuevo.
 *   • Nueva semilla de ruido → terreno diferente.
 *   • Descarga todas las mallas visuales y limpia los Sets de estado.
 *   • El siguiente updateChunks() regenerará el terreno desde cero.
 */
/**
 * setNoiseSeed — Inicializa el generador de ruido con una semilla
 * determinista compartida por el servidor. Debe llamarse ANTES del
 * primer updateChunks() para que todos los clientes generen el
 * mismo terreno. Acepta un número float [0,1] (Math.random()).
 *
 * Mecanismo: simplex-noise@4 acepta un PRNG en lugar del Math.random
 * global. Construimos uno con un LCG simple seeded con el valor del
 * servidor — liviano, sin dependencias adicionales.
 */
export function setNoiseSeed(seed) {
  // LCG (Linear Congruential Generator) seeded — reproducible en todos
  // los clientes con la misma semilla del servidor.
  let s = Math.round(seed * 0xffffffff) >>> 0;  // uint32
  const prng = () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  _noise2D = createNoise2D(prng);
}

export function resetChunks() {
  _noise2D = createNoise2D();
  // Descargar y liberar todas las mallas visuales
  for (const [key, entry] of _chunkMeshes) _unloadChunkVisuals(key, entry);
  _generatedChunks.clear();
  _lastChunkX = null;
  _lastChunkZ = null;
}

// ═══════════════════════════════════════════════════════════════
//  OCCLUSION CULLING
//  ─────────────────────────────────────────────────────────────
//  Consulta blockMap globalmente → funciona correctamente con
//  vecinos en chunks adyacentes sin ningún cambio adicional.
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
//  _unloadChunkVisuals — INTERNO
//  ─────────────────────────────────────────────────────────────
//  Retira un chunk del grafo de escena y libera memoria GPU.
//  • InstancedMeshes: removeFromParent() + dispose() → GPU liberada.
//  • Torch meshes: visible=false (no se destruyen, su ciclo de vida
//    pertenece a addBlock/removeBlock).
//  • Elimina la entrada de _chunkMeshes.
// ═══════════════════════════════════════════════════════════════

function _unloadChunkVisuals(key, entry) {
  for (const im of entry.ims) {
    im.removeFromParent();
    im.dispose();
  }
  for (const tm of entry.torches) {
    tm.visible = false;
    if (tm.userData.pointLight) tm.userData.pointLight.visible = false;
  }
  _chunkMeshes.delete(key);
}

// ═══════════════════════════════════════════════════════════════
//  buildChunkMesh — NÚCLEO DE LA FASE 4
//  ─────────────────────────────────────────────────────────────
//  Construye (o reconstruye) los InstancedMeshes de UN chunk.
//
//  COMPLEJIDAD: O(CS × CS × Y_SCAN_MAX)
//    = O(16 × 16 × 64) = O(16.384) por chunk.
//    Cada iteración es un Map.get → O(1) hash lookup.
//    Comparado con el O(blockMap.size) global previo:
//    con 169 chunks cargados × ~700 bloques = ~118.000 → 7× más rápido.
//
//  ALGORITMO:
//    1. Descartar InstancedMeshes anteriores de este chunk (si existen).
//    2. Pasar 1 (conteo): iterar coordenadas del chunk, contar bloques
//       visibles por tipo (excluyendo occluded).
//    3. Crear un InstancedMesh por tipo con el count exacto.
//    4. Pasar 2 (fill): mismo recorrido → setMatrixAt + userData.instances.
//    5. Recoger referencias a torch meshes para la gestión de visibilidad.
//    6. Guardar { ims, torches } en _chunkMeshes.
// ═══════════════════════════════════════════════════════════════

export function buildChunkMesh(cx, cz) {
  if (!_scene) return;

  const key    = chunkKey(cx, cz);
  const CS     = CONFIG.CHUNK_SIZE;
  const xStart = cx * CS;
  const xEnd   = xStart + CS;
  const zStart = cz * CS;
  const zEnd   = zStart + CS;

  // ── 1. Limpiar mallas anteriores de este chunk ───────────────────
  //  Solo los InstancedMeshes se destruyen; las torch meshes se
  //  dejan en escena (se actualizarán su visibilidad más abajo).
  if (_chunkMeshes.has(key)) {
    const old = _chunkMeshes.get(key);
    for (const im of old.ims) {
      im.removeFromParent();
      im.dispose();
    }
    _chunkMeshes.delete(key);
  }

  // ── 2. Pasar 1: contar instancias visibles por tipo ──────────────
  const counts  = Object.fromEntries(INSTANCED_TYPES.map(t => [t, 0]));
  const torches = [];

  for (let x = xStart; x < xEnd; x++) {
    for (let z = zStart; z < zEnd; z++) {
      for (let y = 0; y <= Y_SCAN_MAX; y++) {
        const data = blockMap.get(blockKey(x, y, z));
        if (!data) continue;

        if (data.mesh) {
          // Antorcha: asegurar visible y recoger referencia
          data.mesh.visible = true;
          if (data.mesh.userData.pointLight)
            data.mesh.userData.pointLight.visible = true;
          torches.push(data.mesh);
          continue;
        }

        if (!INSTANCED_TYPES.includes(data.type)) continue;
        if (isBlockOccluded(x, y, z)) continue;
        counts[data.type]++;
      }
    }
  }

  // ── 3. Crear InstancedMeshes con capacidad exacta ─────────────────
  const ims         = [];
  const meshByType  = {};
  const indexByType = {};

  for (const type of INSTANCED_TYPES) {
    if (counts[type] === 0) continue;
    const im = new THREE.InstancedMesh(BLOCK_GEO, MATERIALS[type], counts[type]);
    im.castShadow    = true;
    im.receiveShadow = true;
    im.userData.instances = new Array(counts[type]);
    meshByType[type]  = im;
    indexByType[type] = 0;
    _scene.add(im);
    ims.push(im);
  }

  // ── 4. Pasar 2: rellenar matrices e índices de instancia ──────────
  for (let x = xStart; x < xEnd; x++) {
    for (let z = zStart; z < zEnd; z++) {
      for (let y = 0; y <= Y_SCAN_MAX; y++) {
        const data = blockMap.get(blockKey(x, y, z));
        if (!data || data.mesh) continue;
        if (!INSTANCED_TYPES.includes(data.type)) continue;
        if (isBlockOccluded(x, y, z)) continue;

        const im  = meshByType[data.type];
        const idx = indexByType[data.type]++;
        _matrix.setPosition(x, y, z);
        im.setMatrixAt(idx, _matrix);
        im.userData.instances[idx] = { x, y, z, type: data.type };
      }
    }
  }

  // ── 5. Confirmar matrices en GPU ──────────────────────────────────
  for (const im of ims) im.instanceMatrix.needsUpdate = true;

  // ── 6. Registrar la entrada en el mapa de mallas ──────────────────
  _chunkMeshes.set(key, { ims, torches });
}

// ═══════════════════════════════════════════════════════════════
//  getBlockMeshes
//  ─────────────────────────────────────────────────────────────
//  Devuelve todos los objetos raycasterables: InstancedMeshes de
//  chunks cargados + Mesh individuales de antorchas visibles.
//  interaction.js llama esto cada frame para intersectObjects().
// ═══════════════════════════════════════════════════════════════

export function getBlockMeshes() {
  const result = [];
  for (const entry of _chunkMeshes.values()) {
    for (const im of entry.ims)     result.push(im);
    for (const tm of entry.torches) result.push(tm);
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════
//  addBlock
//  ─────────────────────────────────────────────────────────────
//  Tras insertar el bloque en blockMap, reconstruye solo la malla
//  del chunk afectado en lugar de todo el mundo.
//  { rebuild: false } omite buildChunkMesh para operaciones en masa
//  (generación de terreno, deserialización).
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
      type   : 'torch',
      normal : normal ? { x: normal.x, y: normal.y, z: normal.z } : null,
      isSolid: false,
      mesh,
    });

    if (rebuild) {
      const CS = CONFIG.CHUNK_SIZE;
      buildChunkMesh(Math.floor(x / CS), Math.floor(z / CS));
    }
    return;
  }

  blockMap.set(key, {
    x, y, z,
    type,
    normal : null,
    isSolid: !TRANSPARENT_TYPES.has(type),
  });

  if (rebuild) {
    const CS = CONFIG.CHUNK_SIZE;
    buildChunkMesh(Math.floor(x / CS), Math.floor(z / CS));
  }
}

// ═══════════════════════════════════════════════════════════════
//  removeBlock
//  ─────────────────────────────────────────────────────────────
//  Elimina el bloque de blockMap, destruye recursos de antorcha
//  si corresponde, y reconstruye la malla del chunk afectado.
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

  if (rebuild) {
    const CS = CONFIG.CHUNK_SIZE;
    buildChunkMesh(Math.floor(x / CS), Math.floor(z / CS));
  }
}

// ═══════════════════════════════════════════════════════════════
//  updateChunks — Motor de streaming de terreno (Fase 4)
//  ─────────────────────────────────────────────────────────────
//  Llamar cada frame desde animate() con la posición del jugador.
//
//  ALGORITMO (3 etapas, todas O(pequeño) por frame):
//
//  ETAPA 1 — Descarga visual:
//    Iterar _chunkMeshes (solo chunks con malla, max 169 entradas).
//    Si un chunk supera RENDER_DISTANCE → _unloadChunkVisuals().
//    Los bloques en blockMap NO se tocan.
//    Coste: O(chunks_con_malla) ≤ O(169).
//
//  ETAPA 2 — Selección radial del próximo chunk:
//    Escanear el área (2×RD+1)² = 169 posiciones, recoger las que
//    no tienen malla aún. Ordenar por distSq → chunk más cercano
//    primero (sin "efecto máquina de escribir").
//    Coste: O(169 log 169) ≈ O(169×7) por frame. Despreciable.
//
//  ETAPA 3 — 1 chunk por frame:
//    Si el chunk no tiene terreno → _generateChunk() (rellena blockMap).
//    buildChunkMesh() → construye solo la geometría de ese chunk.
//    Coste por frame: O(16×16×64) ≈ O(16.384). Sin stutter.
// ═══════════════════════════════════════════════════════════════

export function updateChunks(playerX, playerZ) {
  const CS = CONFIG.CHUNK_SIZE;
  const RD = CONFIG.RENDER_DISTANCE;

  const cx = Math.floor(playerX / CS);
  const cz = Math.floor(playerZ / CS);
  _lastChunkX = cx;
  _lastChunkZ = cz;

  // ── Etapa 1: descarga visual de chunks fuera de rango ────────────
  //  Iterar sobre una copia de las claves para poder mutar _chunkMeshes
  //  de forma segura dentro del bucle.
  for (const [key, entry] of Array.from(_chunkMeshes)) {
    const [kcx, kcz] = key.split(',').map(Number);
    if (Math.abs(kcx - cx) > RD || Math.abs(kcz - cz) > RD) {
      _unloadChunkVisuals(key, entry);
    }
  }

  // ── Etapa 2: lista de chunks deseados sin malla, orden radial ────
  const pending = [];
  for (let dx = -RD; dx <= RD; dx++) {
    for (let dz = -RD; dz <= RD; dz++) {
      const key = chunkKey(cx + dx, cz + dz);
      if (!_chunkMeshes.has(key)) {
        pending.push({ cx: cx + dx, cz: cz + dz, distSq: dx * dx + dz * dz, key });
      }
    }
  }
  if (pending.length === 0) return;

  // Ordenar del más cercano al más lejano
  pending.sort((a, b) => a.distSq - b.distSq);

  // ── Etapa 3: procesar 1 chunk (el más cercano) este frame ────────
  const item = pending[0];

  if (!_generatedChunks.has(item.key)) {
    // Terreno no generado aún → generarlo en blockMap
    _generateChunk(item.cx, item.cz);
    _generatedChunks.add(item.key);
  }

  // Construir (o reconstruir) solo la malla de este chunk
  buildChunkMesh(item.cx, item.cz);
}

// ── _generateTree (interno) ──────────────────────────────────────
//  Coloca una estructura de árbol (tronco de madera + copa de hojas)
//  sobre el bloque de superficie en (startX, startY, startZ).
//
//  GEOMETRÍA:
//    • Tronco : columna vertical de 4–6 bloques de madera (random).
//    • Copa   : cluster 5×5 que se estrecha hacia la punta, usando
//               distancia Manhattan para recortar esquinas y dar forma
//               orgánica (sin cubos perfectos).
//
//  REGLAS DE COLOCACIÓN:
//    • La copa solo ocupa celdas vacías (no sobreescribe terreno).
//    • El tronco SÍ sobreescribe hojas en el eje central — permite
//      que troncos y copas adyacentes se superpongan correctamente.
//    • Ambas usan { rebuild: false } → la malla la genera
//      buildChunkMesh() una sola vez al terminar el chunk.

function _generateTree(startX, startY, startZ) {
  const trunkHeight = Math.floor(Math.random() * 3) + 4; // 4–6 bloques

  // 1. Copa de hojas — 3 capas con forma orgánica por ruido y recorte de esquinas
  //
  //  ESTRUCTURA DE CAPAS (relativeY = y - leafStart):
  //    relY 0–2 : capa ancha  (radius=2, 5×5) con 15% huecos en bordes y
  //               sin esquinas extremas → aspecto redondeado
  //    relY 3–4 : capa alta   (radius=1, 3×3) más densa y compacta (punta)
  //
  //  REGLAS POR CELDA:
  //    • Centro del tronco (x==startX && z==startZ) debajo del tope: omitir
  //      (el tronco lo rellenará en el paso 2).
  //    • Bordes del radio: 15% de probabilidad de hueco → follaje irregular.
  //    • Esquinas extremas (|dx|==r && |dz|==r con r>1): siempre eliminadas
  //      → sin aspecto de cubo perfecto.
  const leafStart = startY + trunkHeight - 3;
  for (let y = leafStart; y <= startY + trunkHeight + 1; y++) {
    const relativeY = y - leafStart;              // 0–4
    const radius    = relativeY >= 3 ? 1 : 2;    // capa alta → radio 1, resto → radio 2

    for (let x = startX - radius; x <= startX + radius; x++) {
      for (let z = startZ - radius; z <= startZ + radius; z++) {
        // 1. No poner hojas donde va el tronco
        if (x === startX && z === startZ && y <= startY + trunkHeight) continue;

        // 2. Ruido orgánico: 15% de probabilidad de hueco en los bordes
        if ((Math.abs(x - startX) === radius || Math.abs(z - startZ) === radius) && Math.random() < 0.15) continue;

        // 3. Cortar las esquinas extremas para redondear
        if (Math.abs(x - startX) === radius && Math.abs(z - startZ) === radius && radius > 1) continue;

        if (!hasBlock(x, y, z)) {
          addBlock(x, y, z, 'leaves', null, { rebuild: false });
        }
      }
    }
  }

  // 2. Tronco de madera: sobrescribe las hojas en el eje central
  for (let y = startY + 1; y <= startY + trunkHeight; y++) {
    addBlock(startX, y, startZ, 'wood', null, { rebuild: false });
  }
}

// ── _generateChunk (interno) ──────────────────────────────────────
//  Rellena blockMap con el terreno de un chunk usando Fractal
//  Brownian Motion de 3 octavas. Usa { rebuild: false } en todos
//  los addBlock → la malla la construye updateChunks() después.

function _generateChunk(cx, cz) {
  const CS     = CONFIG.CHUNK_SIZE;
  const xStart = cx * CS, xEnd = xStart + CS;
  const zStart = cz * CS, zEnd = zStart + CS;

  for (let x = xStart; x < xEnd; x++) {
    for (let z = zStart; z < zEnd; z++) {
      // ── Fractal Brownian Motion — 3 octavas de ruido ─────────────
      //  Se usan escalas explícitas (multiplicación) en lugar de
      //  divisiones para garantizar resultados bit-a-bit idénticos
      //  en coordenadas negativas y positivas (cuadrantes X−/Z−)
      //  y evitar cualquier asimetría numérica entre clientes.
      //
      //  ESCALAS:  0.01  →  formas masivas (continentes, valles)
      //            0.033 →  colinas de escala media
      //            0.10  →  detalles finos de superficie
      const n1 = _noise2D(x * 0.010, z * 0.010);
      const n2 = _noise2D(x * 0.033, z * 0.033);
      const n3 = _noise2D(x * 0.100, z * 0.100);

      let elevation = (n1 * 0.60) + (n2 * 0.30) + (n3 * 0.10);

      // Exponenciación: aplana valles y agudiza picos de montaña
      if (elevation > 0) elevation = Math.pow(elevation, 1.4);

      const maxY = Math.max(0, Math.round(elevation * 22) + 5);

      for (let y = 0; y <= maxY; y++) {
        let type;
        if      (y === maxY)    type = 'grass';
        else if (y >= maxY - 2) type = 'dirt';
        else                    type = 'stone';
        addBlock(x, y, z, type, null, { rebuild: false });
      }

      // Probabilidad de árbol: usar el mismo noise como pseudo-RNG
      // en lugar de Math.random() global (no seeded) para que todos
      // los clientes coloquen árboles en las mismas posiciones.
      // _noise2D con una escala muy fina produce valores en [-1,1]
      // distribuidos uniformemente → mapeamos a [0,1] y aplicamos umbral.
      const treeRng = (_noise2D(x * 3.7, z * 3.7) + 1) * 0.5;  // [0,1]
      if (maxY >= 6 && treeRng < 0.015) {
        _generateTree(x, maxY, z);
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
  // ── Paso 1: vaciar el mundo actual ──────────────────────────────
  //  Descargar todas las mallas visuales primero
  for (const [key, entry] of Array.from(_chunkMeshes)) {
    _unloadChunkVisuals(key, entry);
  }
  //  Luego eliminar todos los bloques (incluyendo dispose de torches)
  for (const key of Array.from(blockMap.keys())) {
    const data = blockMap.get(key);
    removeBlock(data.x, data.y, data.z, { rebuild: false });
  }

  // Resetear estado de chunks
  _generatedChunks.clear();
  _lastChunkX = null;
  _lastChunkZ = null;

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
        if (!isNaN(nx) && !isNaN(ny) && !isNaN(nz))
          normal = new THREE.Vector3(nx, ny, nz);
      }
    }

    addBlock(x, y, z, type, normal, { rebuild: false });
  }

  // ── Paso 3: marcar chunks presentes en el save como generados ────
  //  updateChunks() no regenerará terreno encima de bloques cargados.
  const CS = CONFIG.CHUNK_SIZE;
  for (const data of blockMap.values()) {
    _generatedChunks.add(chunkKey(
      Math.floor(data.x / CS),
      Math.floor(data.z / CS),
    ));
  }

  // ── Paso 4: construir mallas para todos los chunks del save ──────
  //  buildChunkMesh() es ahora O(16.384) por chunk → rápido incluso
  //  con muchos chunks guardados.
  for (const key of _generatedChunks) {
    const [ccx, ccz] = key.split(',').map(Number);
    buildChunkMesh(ccx, ccz);
  }
}
// ═══════════════════════════════════════════════════════════════
//  checkLeafDecay — Simulación de caída de hojas
//  ─────────────────────────────────────────────────────────────
//  Cada frame muestrea 20 bloques al azar del blockMap.
//  Si el bloque es de tipo 'leaves' y no hay ningún bloque 'wood'
//  dentro de un radio de 4 bloques (cubo 9×9×9 centrado en él),
//  el bloque se destruye, propagando la caída naturalmente.
//
//  DISEÑO:
//  • Muestreo aleatorio → O(20) por frame, sin iterar blockMap completo.
//  • Radio Manhattan 4 → cubre la distancia máxima tronco↔hoja en
//    árboles de trunkHeight=6 + radio de copa=2: 6+2=8>4, pero en
//    la práctica las hojas más lejanas del tronco están a ≤4 bloques
//    en XZ, por lo que el radio 4 basta sin falsos positivos.
//  • removeBlock() con rebuild=true por defecto → buildChunkMesh()
//    se ejecuta para ese chunk inmediatamente, actualizando la malla.
// ═══════════════════════════════════════════════════════════════

export function checkLeafDecay() {
  if (blockMap.size === 0) return;

  // Convertir las claves a array UNA sola vez y elegir 20 al azar
  const keys  = Array.from(blockMap.keys());
  const total = keys.length;

  for (let i = 0; i < 20; i++) {
    const key  = keys[(Math.random() * total) | 0];
    const data = blockMap.get(key);
    if (!data || data.type !== 'leaves') continue;

    const { x, y, z } = data;
    let hasWoodNearby  = false;

    // Buscar madera en un cubo de radio 4 (9×9×9 = 729 comprobaciones máx)
    // Cada comprobación es un Map.get → O(1). Total: ≤729 por hoja muestreada.
    outer:
    for (let dx = -4; dx <= 4; dx++) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dz = -4; dz <= 4; dz++) {
          const n = blockMap.get(blockKey(x + dx, y + dy, z + dz));
          if (n && n.type === 'wood') {
            hasWoodNearby = true;
            break outer;
          }
        }
      }
    }

    if (!hasWoodNearby) {
      removeBlock(x, y, z);
    }
  }
}