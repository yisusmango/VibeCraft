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
import { createNoise2D, createNoise3D } from 'https://unpkg.com/simplex-noise@4.0.1/dist/esm/simplex-noise.js';

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
  // 1. Solid base coat — all pixels start at alpha = 1 (hex colours = fully opaque)
  noiseFill(ctx, 0, 0, w, h, ['#2d6e1e','#1f5214','#3a7e28','#255c18','#4a8a32']);

  // 2. Bright highlight specks — higher opacity so they read through the canopy
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = 'rgba(110,210,60,0.8)';
    ctx.fillRect((Math.random() * (w - 2)) | 0, (Math.random() * (h - 2)) | 0, 2, 2);
  }

  // 3. Punch fully-transparent holes (alpha = 0) for alphaTest: 0.5 to discard.
  //    clearRect writes alpha = 0 unconditionally, bypassing the compositing mode —
  //    the only Canvas 2D op that guarantees absolute transparency on existing pixels.
  for (let i = 0; i < 50; i++) {
    ctx.clearRect((Math.random() * w) | 0, (Math.random() * h) | 0, 1, 1);
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
const texWater = makeTexture(S, (ctx, w, h) => {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(30,90,180,0.60)';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 30; i++) {
    ctx.fillStyle = `rgba(${20 + (Math.random() * 40) | 0},${70 + (Math.random() * 60) | 0},${160 + (Math.random() * 60) | 0},0.55)`;
    ctx.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 1, 1);
  }
  ctx.fillStyle = 'rgba(120,200,255,0.30)';
  ctx.fillRect(0, 0, w, 2);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect((w / 2 - 2) | 0, (h / 2 - 1) | 0, 4, 2);
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
  leaves: Array.from({ length: 6 }, () => new THREE.MeshLambertMaterial({
    map: texLeaves,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
    // Polygon offset shifts the depth value of leaf fragments slightly toward the camera
    // before the Z-buffer write. This breaks the depth tie between coplanar faces of
    // adjacent leaf blocks — the GPU no longer flips the depth winner frame-to-frame.
    // factor: -1 scales the bias by the fragment's slope (handles oblique angles).
    // units:  -1 adds a fixed minimum bias (handles head-on, slope ≈ 0 views).
    polygonOffset      : true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits : -1,
  })),
  sand:   Array.from({ length: 6 }, () => new THREE.MeshLambertMaterial({ map: texSand   })),
  glass:  Array.from({ length: 6 }, () => new THREE.MeshLambertMaterial({
    map: texGlass, transparent: true, opacity: 0.55, depthWrite: false,
  })),
  water: Array.from({ length: 6 }, () => new THREE.MeshLambertMaterial({
    map: texWater, transparent: true, opacity: 0.7,
    side: THREE.DoubleSide, depthWrite: false,
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

const TRANSPARENT_TYPES = new Set(['glass', 'leaves', 'torch', 'water']);
const INSTANCED_TYPES   = ['grass', 'dirt', 'stone', 'wood', 'leaves', 'sand', 'glass', 'water'];

// ── Chunk-Level Mesh Storage ──────────────────────────────────────
//  Key  : "cx,cz"
//  Value: { ims: THREE.InstancedMesh[], torches: THREE.Mesh[] }
//    ims     → InstancedMeshes de bloques sólidos (se crean/destruyen
//               en buildChunkMesh)
//    torches → referencias a los THREE.Mesh de antorchas ya existentes
//               en escena (no se destruyen aquí, solo se muestran/ocultan)
const _chunkMeshes = new Map();

const _matrix = new THREE.Matrix4();
const _scaleV = new THREE.Vector3();
const _posV   = new THREE.Vector3();
const _quatI  = new THREE.Quaternion();

// Rango vertical escaneado para buildChunkMesh.
// El mundo ahora soporta subsuelo profundo: y ∈ [-64, 64].
const Y_SCAN_MIN = -64;
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
let _noise3D           = createNoise3D();
const _generatedChunks = new Set();
const _chunkMinYGenerated = new Map();
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
  _noise3D = createNoise3D(prng);
}

export function resetChunks() {
  // Descargar y liberar todas las mallas visuales
  for (const [key, entry] of _chunkMeshes) _unloadChunkVisuals(key, entry);
  _generatedChunks.clear();
  _chunkMinYGenerated.clear();
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

// ═══════════════════════════════════════════════════════════════
//  FACE_DEFS — Definiciones de las 6 caras de un voxel
//  ─────────────────────────────────────────────────────────────
//  Basado en el manual oficial de Three.js (voxel geometry).
//  • corners: 4 offsets de vértice desde el centro del bloque.
//    Los valores son ±0.5; la posición final es (bx+cx, by+cy, bz+cz).
//  • Orden de índices por quad: v0,v1,v2 y v2,v1,v3 (CCW front-face).
//  • slot: índice en el array MATERIALS[type]
//    (importa para grass, donde top/bottom/sides tienen texturas distintas).
// ═══════════════════════════════════════════════════════════════
const FACE_DEFS = [
  { dir:[-1, 0, 0], slot:1, // izquierda −X
    corners:[[-0.5, 0.5,-0.5],[-0.5,-0.5,-0.5],[-0.5, 0.5, 0.5],[-0.5,-0.5, 0.5]],
    uvs:[[0,1],[0,0],[1,1],[1,0]] },
  { dir:[ 1, 0, 0], slot:0, // derecha +X
    corners:[[ 0.5, 0.5, 0.5],[ 0.5,-0.5, 0.5],[ 0.5, 0.5,-0.5],[ 0.5,-0.5,-0.5]],
    uvs:[[0,1],[0,0],[1,1],[1,0]] },
  { dir:[ 0,-1, 0], slot:3, // fondo −Y
    corners:[[ 0.5,-0.5, 0.5],[-0.5,-0.5, 0.5],[ 0.5,-0.5,-0.5],[-0.5,-0.5,-0.5]],
    uvs:[[1,0],[0,0],[1,1],[0,1]] },
  { dir:[ 0, 1, 0], slot:2, // techo +Y
    corners:[[-0.5, 0.5, 0.5],[ 0.5, 0.5, 0.5],[-0.5, 0.5,-0.5],[ 0.5, 0.5,-0.5]],
    uvs:[[1,0],[0,0],[1,1],[0,1]] },
  { dir:[ 0, 0,-1], slot:5, // trasera −Z
    corners:[[ 0.5,-0.5,-0.5],[-0.5,-0.5,-0.5],[ 0.5, 0.5,-0.5],[-0.5, 0.5,-0.5]],
    uvs:[[0,0],[1,0],[0,1],[1,1]] },
  { dir:[ 0, 0, 1], slot:4, // frontal +Z
    corners:[[-0.5,-0.5, 0.5],[ 0.5,-0.5, 0.5],[-0.5, 0.5, 0.5],[ 0.5, 0.5, 0.5]],
    uvs:[[0,0],[1,0],[0,1],[1,1]] },
];

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
  for (const m of entry.ims) {
    m.removeFromParent();
    m.geometry.dispose();   // BufferGeometry único por chunk → liberar GPU
    // Los materiales son compartidos globalmente → NO se disponen aquí
  }
  for (const tm of entry.torches) {
    tm.visible = false;
    if (tm.userData.pointLight) tm.userData.pointLight.visible = false;
  }
  _chunkMeshes.delete(key);
}

// ═══════════════════════════════════════════════════════════════
//  buildChunkMesh — FASE 5: Per-Face BufferGeometry Culling
//  ─────────────────────────────────────────────────────────────
//  Para cada bloque del chunk comprueba individualmente las 6 caras.
//  Solo se genera la geometría de las caras EXPUESTAS (vecino = aire
//  o bloque transparente de distinto tipo). Las caras enterradas entre
//  bloques sólidos se descartan → reducción drástica de triángulos.
//
//  SALIDA: Un THREE.Mesh con BufferGeometry por tipo de material
//    activo en el chunk. Grass usa multi-material (grupos por cara)
//    para aplicar texturas distintas en techo/suelo/laterales.
//
//  RAYCASTING: Los meshes llevan userData.isChunkMesh=true.
//    interaction.js deriva las coordenadas del bloque a partir de
//    hit.point y hit.face.normal (no se necesita instanceId).
//
//  VECINOS ENTRE CHUNKS: blockMap es global → los bloques en el
//    borde del chunk comprueban correctamente al chunk adyacente.
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
  if (_chunkMeshes.has(key)) {
    const old = _chunkMeshes.get(key);
    for (const m of old.ims) {
      m.removeFromParent();
      m.geometry.dispose();   // BufferGeometry único por chunk → liberar GPU
    }
    _chunkMeshes.delete(key);
  }

  // ── 2. Inicializar buffers de caras por tipo ─────────────────────
  // 'grass': 6 buffers (uno por slot de material, para top/bottom/sides).
  // Otros tipos: 1 buffer (todos los faces comparten el mismo material).
  const makeBuf = () => ({ pos: [], nrm: [], uv: [], vcnt: 0 });
  const faceData = {};
  for (const type of INSTANCED_TYPES) {
    faceData[type] = (type === 'grass')
      ? Array.from({ length: 6 }, makeBuf)
      : [makeBuf()];
  }

  // ── 3. Recorrer bloques del chunk y recoger caras expuestas ──────
  const torches = [];

  for (let x = xStart; x < xEnd; x++) {
    for (let z = zStart; z < zEnd; z++) {
      for (let y = Y_SCAN_MIN; y <= Y_SCAN_MAX; y++) {
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
        const type = data.type;

        // Ajuste de altura para agua (waterLevel escala el tope del bloque)
        const isWater = (type === 'water');
        const yTop    = isWater ? y - 0.5 + (data.waterLevel / 8) * 0.9 : y + 0.5;

        for (const fd of FACE_DEFS) {
          // ── Regla de Oro: comprobar vecino en la dirección de la cara ─
          // El vecino se busca en blockMap global → vecinos de chunks
          // adyacentes se comprueban automáticamente sin lógica extra.
          const neighb = blockMap.get(
            blockKey(x + fd.dir[0], y + fd.dir[1], z + fd.dir[2])
          );
          // Cara OCULTA si el vecino es sólido, o es el mismo tipo transparente
          if (neighb && (!TRANSPARENT_TYPES.has(neighb.type) || neighb.type === type)) continue;

          // ── Seleccionar buffer de destino ────────────────────────
          const buf = (type === 'grass') ? faceData.grass[fd.slot] : faceData[type][0];

          // ── Añadir los 4 vértices del quad ───────────────────────
          const [dnx, dny, dnz] = fd.dir;
          for (let vi = 0; vi < 4; vi++) {
            const [cx_off, cy_off, cz_off] = fd.corners[vi];
            // Posición en espacio mundo; agua ajusta el vértice superior
            const vx = x + cx_off;
            const vy = isWater ? (cy_off > 0 ? yTop : y - 0.5) : (y + cy_off);
            const vz = z + cz_off;
            buf.pos.push(vx, vy, vz);
            buf.nrm.push(dnx, dny, dnz);
            buf.uv.push(fd.uvs[vi][0], fd.uvs[vi][1]);
          }
          buf.vcnt += 4;
        }
      }
    }
  }

  // ── 4. Construir BufferGeometry y Mesh por tipo ──────────────────
  const meshes = [];

  for (const type of INSTANCED_TYPES) {
    const slots      = faceData[type];
    const totalVerts = slots.reduce((s, b) => s + b.vcnt, 0);
    if (totalVerts === 0) continue;

    const numQuads = totalVerts / 4;
    const posArr   = new Float32Array(totalVerts * 3);
    const nrmArr   = new Float32Array(totalVerts * 3);
    const uvArr    = new Float32Array(totalVerts * 2);
    const idxArr   = new Uint32Array(numQuads * 6);  // 6 índices por quad

    const geo = new THREE.BufferGeometry();

    let posOff = 0, nrmOff = 0, uvOff = 0, idxOff = 0, vertBase = 0;

    for (let s = 0; s < slots.length; s++) {
      const buf = slots[s];
      if (buf.vcnt === 0) continue;

      // Copiar atributos a los arrays tipados
      for (let i = 0; i < buf.pos.length; i++) posArr[posOff++] = buf.pos[i];
      for (let i = 0; i < buf.nrm.length; i++) nrmArr[nrmOff++] = buf.nrm[i];
      for (let i = 0; i < buf.uv.length;  i++) uvArr[uvOff++]   = buf.uv[i];

      // Índices de triángulo: (v0,v1,v2) y (v2,v1,v3) por quad
      const groupIdxStart = idxOff;
      const numQ = buf.vcnt / 4;
      for (let q = 0; q < numQ; q++) {
        const b = vertBase + q * 4;
        idxArr[idxOff++] = b;     idxArr[idxOff++] = b + 1; idxArr[idxOff++] = b + 2;
        idxArr[idxOff++] = b + 2; idxArr[idxOff++] = b + 1; idxArr[idxOff++] = b + 3;
      }
      vertBase += buf.vcnt;

      // Grupos de material (solo necesarios para grass multi-material)
      if (type === 'grass') {
        const groupCount = idxOff - groupIdxStart;
        if (groupCount > 0) geo.addGroup(groupIdxStart, groupCount, s);
      }
    }

    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('normal',   new THREE.BufferAttribute(nrmArr, 3));
    geo.setAttribute('uv',       new THREE.BufferAttribute(uvArr,  2));
    geo.setIndex(new THREE.BufferAttribute(idxArr, 1));
    geo.computeBoundingSphere();

    // Grass: array de 6 materiales (grupos indexan en él).
    // Resto: material único (slot 0 del array de materiales compartidos).
    const mat  = (type === 'grass') ? MATERIALS.grass : MATERIALS[type][0];
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
    mesh.userData.isChunkMesh = true;  // marca para interaction.js
    _scene.add(mesh);
    meshes.push(mesh);
  }

  // ── 5. Registrar la entrada en el mapa de mallas ──────────────────
  _chunkMeshes.set(key, { ims: meshes, torches });
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

export function addBlock(x, y, z, type = 'grass', normal = null, { rebuild = true, waterLevel = 8, isSource = true } = {}) {
  const key = blockKey(x, y, z);
  const existing = blockMap.get(key);
  if (existing && existing.type !== 'water') return;
  if (existing && existing.type === 'water' && type !== 'water') {
    blockMap.delete(key);
  }

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
    waterLevel: type === 'water' ? waterLevel : 0,
    isSource:   type === 'water' ? isSource   : undefined,
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

export function updateChunks(playerX, playerZ, playerY = 0) {
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
  const targetMinY = _resolveGenerationMinY(playerY);

  if (!_generatedChunks.has(item.key)) {
    // Terreno no generado aún → generarlo en blockMap
    _generateChunk(item.cx, item.cz, targetMinY);
    _generatedChunks.add(item.key);
    _chunkMinYGenerated.set(item.key, targetMinY);
  } else {
    const currentMinY = _chunkMinYGenerated.get(item.key) ?? -63;
    if (targetMinY < currentMinY) {
      _deepenChunk(item.cx, item.cz, currentMinY, targetMinY);
      _chunkMinYGenerated.set(item.key, targetMinY);
    }
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

// ═══════════════════════════════════════════════════════════════
//  CAVE GENERATION — 3D Multi-Fractal Noise
//  ─────────────────────────────────────────────────────────────
//  Minecraft-style "spaghetti" caves: a block is AIR when the
//  absolute value of 3D noise falls in a narrow band around 0.
//  |density| < threshold  →  tunnel void.
//
//  Width variation: a second low-frequency noise layer modulates
//  the threshold, producing wider "rooms" in some areas and
//  narrower squeeze-throughs in others.
//
//  Surface entrances: ~5% of (x,z) columns (deterministic via
//  _noise2D) allow caves to reach the terrain surface; the rest
//  stop CAVE_SURFACE_MARGIN blocks below to stay hidden.
// ═══════════════════════════════════════════════════════════════

const CAVE_THRESHOLD_BASE  = 0.15;  // base air band: [-0.15, +0.15]
const CAVE_THRESHOLD_EXTRA = 0.08;  // additional widening from modulation/chambers
const CAVE_SURFACE_MARGIN  = 3;     // blocks below surface (normal columns)
const CAVE_ENTRANCE_CHANCE = 0.05;  // 5% of columns allow surface breach
const CAVE_MIN_Y           = -60;   // rango principal de cuevas profundas
const CAVE_DEFAULT_MAX_Y   = 5;     // tope normal del tallado

/**
 * 3D multi-fractal cave density.
 * Two octaves of 3D simplex noise blended 70/30.
 * Returns a value roughly in [-1, 1]; tunnel exists when |v| ≈ 0.
 */
function _caveDensity(x, y, z) {
  // Frecuencia baja para túneles anchos y formas grandes.
  const n1 = _noise3D(x * 0.010, y * 0.010, z * 0.010);
  const n2 = _noise3D(x * 0.020, y * 0.020, z * 0.020);
  return n1 * 0.65 + n2 * 0.35;
}

/**
 * Width-modulation noise — low frequency, coordinate offset +500
 * to decorrelate from the primary tunnel sampling.
 * Positive values widen the cave threshold ("rooms").
 */
function _caveWidthMod(x, y, z) {
  return _noise3D((x + 500) * 0.010, (y + 500) * 0.010, (z + 500) * 0.010);
}

// Capa ultra-baja frecuencia para "salas" gigantes conectadas.
function _caveChamberNoise(x, y, z) {
  return _noise3D((x + 1300) * 0.005, (y + 1300) * 0.005, (z + 1300) * 0.005);
}

function _getSurfaceHeight(x, z) {
  const n1 = _noise2D(x * 0.010, z * 0.010);
  const n2 = _noise2D(x * 0.033, z * 0.033);
  const n3 = _noise2D(x * 0.100, z * 0.100);

  let elevation = (n1 * 0.60) + (n2 * 0.30) + (n3 * 0.10);
  if (elevation > 0) elevation = Math.pow(elevation, 1.4);

  return Math.max(-63, Math.min(64, Math.round(elevation * 22)));
}

function _resolveGenerationMinY(playerY = 0) {
  // Subsuelo sólido obligatorio: siempre generar hasta -63 antes del tallado.
  return -63;
}

// Sobrescritura directa para generación de terreno (sin rebuild inmediato).
// Se usa para capas top-down (grass/dirt sobre stone) porque addBlock no
// reemplaza bloques sólidos existentes.
function _setGeneratedBlock(x, y, z, type) {
  blockMap.set(blockKey(x, y, z), {
    x, y, z,
    type,
    normal: null,
    isSolid: !TRANSPARENT_TYPES.has(type),
    waterLevel: type === 'water' ? 8 : 0,
    isSource: type === 'water' ? true : undefined,
  });
}

/**
 * Carves caves through already-placed terrain blocks in blockMap.
 * Only examines stone and dirt (optimisation) and never touches y=-64
 * (bedrock). Removes floating grass when a cave perforates directly
 * beneath the surface layer.
 *
 * @param {number}     xStart   — chunk start X
 * @param {number}     xEnd     — chunk end X (exclusive)
 * @param {number}     zStart   — chunk start Z
 * @param {number}     zEnd     — chunk end Z (exclusive)
 * @param {number}     CS       — chunk size
 * @param {Uint8Array} surfaceY — surface height per column [CS×CS]
 */
function _carveCaves(xStart, xEnd, zStart, zEnd, CS, surfaceY, minYOverride = null, maxYOverride = null) {
  for (let x = xStart; x < xEnd; x++) {
    for (let z = zStart; z < zEnd; z++) {
      const maxY = surfaceY[(x - xStart) * CS + (z - zStart)];
      if (maxY < CAVE_MIN_Y) continue;

      // Deterministic per-column: ~5% allow surface entrance
      const entranceVal  = (_noise2D(x * 7.3, z * 7.3) + 1) * 0.5;
      const allowSurface = entranceVal < CAVE_ENTRANCE_CHANCE;

      const caveFloorBase = Math.max(-63, CAVE_MIN_Y);
      const caveFloor = minYOverride === null
        ? caveFloorBase
        : Math.max(caveFloorBase, minYOverride);

      let caveCeiling = allowSurface
        ? maxY
        : Math.min(CAVE_DEFAULT_MAX_Y, Math.max(caveFloor, maxY - CAVE_SURFACE_MARGIN));

      if (maxYOverride !== null) caveCeiling = Math.min(caveCeiling, maxYOverride);
      if (caveFloor > caveCeiling) continue;

      for (let y = caveFloor; y <= caveCeiling; y++) { // y=-64 es bedrock: nunca tallar
        const key = blockKey(x, y, z);
        const data = blockMap.get(key);
        if (!data) continue;
        if (data.type !== 'stone' && data.type !== 'dirt') continue;

        const density   = _caveDensity(x, y, z);
        const widthMod  = _caveWidthMod(x, y, z);
        const chamberN  = _caveChamberNoise(x, y, z);
        const threshold = CAVE_THRESHOLD_BASE
                        + Math.max(0, widthMod) * (CAVE_THRESHOLD_EXTRA * 0.45)
                        + Math.max(0, chamberN) * (CAVE_THRESHOLD_EXTRA * 1.25);

        if (Math.abs(density) < threshold) {
          blockMap.delete(key);

          // Prevent floating grass above the carved block
          const aboveKey  = blockKey(x, y + 1, z);
          const aboveData = blockMap.get(aboveKey);
          if (aboveData && aboveData.type === 'grass') {
            blockMap.delete(aboveKey);
          }
        }
      }
    }
  }
}

// ── _generateChunk (interno) ──────────────────────────────────────
//  Rellena blockMap con el terreno de un chunk usando Fractal
//  Brownian Motion de 3 octavas, luego talla cuevas con ruido 3D.
//  Usa { rebuild: false } en todos los addBlock → la malla la
//  construye updateChunks() después.

function _generateChunk(cx, cz, minY = -63) {
  const CS     = CONFIG.CHUNK_SIZE;
  const xStart = cx * CS, xEnd = xStart + CS;
  const zStart = cz * CS, zEnd = zStart + CS;

  // Almacén de alturas de superficie para la pasada de cuevas (admite Y negativo)
  const surfaceY = new Int16Array(CS * CS);

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
      const maxY = _getSurfaceHeight(x, z);
      surfaceY[(x - xStart) * CS + (z - zStart)] = maxY;

      // Bedrock fijo en el fondo del mundo
      _setGeneratedBlock(x, -64, z, 'stone');

      // Relleno sólido desde y=-63 hasta la superficie (base de subsuelo profundo)
      for (let y = minY; y <= maxY; y++) {
        _setGeneratedBlock(x, y, z, 'stone');
      }

      // Acabado superficial: capa superior de césped y subsuperficie de tierra.
      // Se aplica después del relleno de piedra para preservar el bioma de superficie.
      if (maxY > -63) {
        _setGeneratedBlock(x, maxY, z, 'grass');
      }
      for (let y = Math.max(-63, maxY - 4); y < maxY; y++) {
        _setGeneratedBlock(x, y, z, 'dirt');
      }

      // Probabilidad de árbol: usar el mismo noise como pseudo-RNG
      // en lugar de Math.random() global (no seeded) para que todos
      // los clientes coloquen árboles en las mismas posiciones.
      const treeRng = (_noise2D(x * 3.7, z * 3.7) + 1) * 0.5;
      if (maxY >= 6 && treeRng < 0.015) {
        _generateTree(x, maxY, z);
      }
    }
  }

  // ── Pasada 2: tallar cuevas en piedra/tierra ────────────────────
  _carveCaves(xStart, xEnd, zStart, zEnd, CS, surfaceY, minY);
}

function _deepenChunk(cx, cz, currentMinY, targetMinY) {
  if (targetMinY >= currentMinY) return;

  const CS     = CONFIG.CHUNK_SIZE;
  const xStart = cx * CS, xEnd = xStart + CS;
  const zStart = cz * CS, zEnd = zStart + CS;
  const surfaceY = new Int16Array(CS * CS);

  for (let x = xStart; x < xEnd; x++) {
    for (let z = zStart; z < zEnd; z++) {
      const maxY = _getSurfaceHeight(x, z);
      surfaceY[(x - xStart) * CS + (z - zStart)] = maxY;

      const fillTop = Math.min(currentMinY - 1, maxY);
      for (let y = targetMinY; y <= fillTop; y++) {
        if (!hasBlock(x, y, z)) _setGeneratedBlock(x, y, z, 'stone');
      }
    }
  }

  _carveCaves(xStart, xEnd, zStart, zEnd, CS, surfaceY, targetMinY, currentMinY - 1);
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
  _chunkMinYGenerated.clear();
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
    const key = chunkKey(
      Math.floor(data.x / CS),
      Math.floor(data.z / CS),
    );
    _generatedChunks.add(key);
    _chunkMinYGenerated.set(key, -63);
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
//  updateFluids — Motor de fluidos (agua) Fase 1
//  ─────────────────────────────────────────────────────────────
//  Itera sobre todos los bloques 'water' en blockMap y propaga:
//    a) Hacia abajo (y-1): si vacío o no sólido → agua con level=8
//    b) Horizontalmente (±x, ±z): si el bloque de abajo es sólido
//       y el nivel actual > 1 → agua con level-1
//
//  Optimización: acumula chunks modificados y reconstruye sus
//  mallas una sola vez al final del tick.
// ═══════════════════════════════════════════════════════════════

export function updateFluids() {
  const CS = CONFIG.CHUNK_SIZE;
  const dirtyChunks = new Set();
  const pendingRemovals = [];

  const waterBlocks = [];
  for (const data of blockMap.values()) {
    if (data.type === 'water') waterBlocks.push(data);
  }

  for (const data of waterBlocks) {
    const { x, y, z, waterLevel } = data;

    // ── Retracción: bloques no-fuente sin soporte se secan ──────
    if (!data.isSource) {
      const above = blockMap.get(blockKey(x, y + 1, z));
      let supported = above && above.type === 'water';

      if (!supported && waterLevel < 8) {
        const horizDirs = [[1,0],[-1,0],[0,1],[0,-1]];
        for (const [dx, dz] of horizDirs) {
          const n = blockMap.get(blockKey(x + dx, y, z + dz));
          if (n && n.type === 'water' && n.waterLevel > waterLevel) {
            supported = true;
            break;
          }
        }
      }

      if (!supported) {
        pendingRemovals.push({ x, y, z });
        continue;
      }
    }

    // ── Expansión: propagación normal ───────────────────────────
    const belowKey = blockKey(x, y - 1, z);
    const below = blockMap.get(belowKey);

    if (!below || (below.type !== 'water' && !below.isSolid)) {
      if (below && below.type !== 'water') {
        removeBlock(x, y - 1, z, { rebuild: false });
        dirtyChunks.add(chunkKey(Math.floor(x / CS), Math.floor(z / CS)));
      }
      if (!blockMap.has(belowKey)) {
        addBlock(x, y - 1, z, 'water', null, { rebuild: false, waterLevel: 8, isSource: false });
        dirtyChunks.add(chunkKey(Math.floor(x / CS), Math.floor(z / CS)));
      }
    } else if (below && below.isSolid) {
      if (waterLevel > 1) {
        const horizDirs = [[1,0],[-1,0],[0,1],[0,-1]];
        for (const [dx, dz] of horizDirs) {
          const nx = x + dx;
          const nz = z + dz;
          const neighborKey = blockKey(nx, y, nz);
          const neighbor = blockMap.get(neighborKey);

          if (!neighbor) {
            addBlock(nx, y, nz, 'water', null, { rebuild: false, waterLevel: waterLevel - 1, isSource: false });
            dirtyChunks.add(chunkKey(Math.floor(nx / CS), Math.floor(nz / CS)));
          } else if (!neighbor.isSolid && neighbor.type !== 'water') {
            removeBlock(nx, y, nz, { rebuild: false });
            addBlock(nx, y, nz, 'water', null, { rebuild: false, waterLevel: waterLevel - 1, isSource: false });
            dirtyChunks.add(chunkKey(Math.floor(nx / CS), Math.floor(nz / CS)));
          }
        }
      }
    }
  }

  // ── Aplicar eliminaciones de corrientes sin soporte ───────────
  for (const { x, y, z } of pendingRemovals) {
    removeBlock(x, y, z, { rebuild: false });
    dirtyChunks.add(chunkKey(Math.floor(x / CS), Math.floor(z / CS)));
  }

  for (const key of dirtyChunks) {
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