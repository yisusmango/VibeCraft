// ═══════════════════════════════════════════════════════════════
//  src/world.js
// ═══════════════════════════════════════════════════════════════
import * as THREE from 'three';
import { CONFIG } from './config.js';

let _scene = null;
export function initWorld(scene) { _scene = scene; }

// ── Helpers de textura ──────────────────────────────────────────
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
  // Tierra en toda la cara (base)
  noiseFill(ctx, 0, 0, w, h, ['#8B5E3C','#7a4d2b','#9a6e4c','#6a3d1c']);
  // BUGFIX: Three.js mapea canvas-fila-0 (TOP del canvas) → TOP de la cara 3D.
  // La franja verde debe pintarse en las primeras 4 filas del canvas
  // para que aparezca en la parte SUPERIOR del bloque lateral, conectando
  // visualmente con texGrassTop. Pintarla en h-4 la colocaba en la base.
  noiseFill(ctx, 0, 0, w, 4, ['#5d8a3c','#4a7a2b','#6a9a49','#52803a']);
});
const texDirt = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#8B5E3C','#7a4d2b','#9a6e4c','#6a3d1c','#a07040']);
});

// ── Piedra (stone) ──────────────────────────────────────────────
// Ruido de grises con grietas oscuras de 1×2 píxeles.
const texStone = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#888','#7a7a7a','#969696','#6e6e6e','#a0a0a0']);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = '#505050';
    ctx.fillRect((Math.random() * (w - 1)) | 0, (Math.random() * (h - 2)) | 0, 1, 2);
  }
});

// ── Madera (wood) ───────────────────────────────────────────────
// Base marrón con vetas verticales cada 4 px y bandas de anillos.
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

// ── Hojas (leaves) ──────────────────────────────────────────────
// Verde oscuro con manchas de luz semi-transparentes.
const texLeaves = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#2d6e1e','#1f5214','#3a7e28','#255c18','#4a8a32']);
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = 'rgba(110,210,60,0.28)';
    ctx.fillRect((Math.random() * (w - 2)) | 0, (Math.random() * (h - 2)) | 0, 2, 2);
  }
});

// ── Arena (sand) ─────────────────────────────────────────────────
// Amarillo pálido con granos individuales oscuros.
const texSand = makeTexture(S, (ctx, w, h) => {
  noiseFill(ctx, 0, 0, w, h, ['#DDD06A','#ccc060','#e8da78','#c8b850','#d4ca64']);
  for (let i = 0; i < 22; i++) {
    ctx.fillStyle = 'rgba(90,70,0,0.14)';
    ctx.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 1, 1);
  }
});

// ── Cristal (glass) ──────────────────────────────────────────────
// Canvas con alfa real: tinte azulado + bordes blancos bevel.
// El material usa transparent:true para respetar el canal alfa.
const texGlass = makeTexture(S, (ctx, w, h) => {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(180,220,242,0.30)';
  ctx.fillRect(0, 0, w, h);
  // Bordes: superior e izquierdo más brillantes → ilusión de bevel
  ctx.fillStyle = 'rgba(255,255,255,0.80)';
  ctx.fillRect(0, 0, w, 1);         // borde superior
  ctx.fillRect(0, 0, 1, h);         // borde izquierdo
  ctx.fillStyle = 'rgba(200,235,255,0.50)';
  ctx.fillRect(0, h - 1, w, 1);     // borde inferior
  ctx.fillRect(w - 1, 0, 1, h);     // borde derecho
  // Brillo especular en esquina superior-izquierda
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.fillRect(1, 1, 3, 3);
});

// ── Antorcha (torch) ─────────────────────────────────────────────
//  La antorcha usa geometría 0.2×0.6×0.2 en vez del cubo estándar,
//  por lo que sus texturas son simples:
//    • Palo (4 caras laterales + base): marrón oscuro MeshLambertMaterial
//    • Llama (cara +Y): amarillo/naranja MeshBasicMaterial para simular
//      auto-iluminación (no depende de la DirectionalLight del sol).
//
//  La PointLight se instancia en addBlock, NO en los materiales;
//  los materiales son sólo la apariencia visual del mesh.

const texTorchStick = makeTexture(S, (ctx, w, h) => {
  // Base marrón oscuro del palo
  noiseFill(ctx, 0, 0, w, h, ['#5a2e0c','#6b3a1f','#4a2008','#7a4828']);
  // Veta central para dar volumen
  ctx.fillStyle = 'rgba(255,180,80,0.15)';
  ctx.fillRect((w / 2 - 1) | 0, 0, 2, h);
});

// ═══════════════════════════════════════════════════════════════
//  🧱  GEOMETRÍA Y MATERIALES
//  Orden de caras BoxGeometry:
//    0:+X  1:-X  2:+Y(arriba)  3:-Y(abajo)  4:+Z  5:-Z
// ═══════════════════════════════════════════════════════════════
export const BLOCK_GEO = new THREE.BoxGeometry(1, 1, 1);

export const MATERIALS = {
  // ── Originales ────────────────────────────────────────────────
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

  // ── Nuevos (Fase 2) ───────────────────────────────────────────
  stone: Array.from({ length: 6 }, () =>
    new THREE.MeshLambertMaterial({ map: texStone })),

  wood: Array.from({ length: 6 }, () =>
    new THREE.MeshLambertMaterial({ map: texWood })),

  leaves: Array.from({ length: 6 }, () =>
    new THREE.MeshLambertMaterial({ map: texLeaves })),

  sand: Array.from({ length: 6 }, () =>
    new THREE.MeshLambertMaterial({ map: texSand })),

  // transparent + depthWrite:false → Three.js ordena el cristal
  // después de opacos y no ocluye la geometría detrás de él.
  glass: Array.from({ length: 6 }, () =>
    new THREE.MeshLambertMaterial({
      map: texGlass, transparent: true, opacity: 0.55, depthWrite: false,
    })),

  // ── Antorcha (torch) ──────────────────────────────────────────
  //  Cara +Y (índice 2): MeshBasicMaterial amarillo-naranja para
  //  simular auto-iluminación. El resto: MeshLambertMaterial marrón.
  //  La PointLight se gestiona en addBlock / removeBlock.
  torch: [
    new THREE.MeshLambertMaterial({ map: texTorchStick }),  // +X
    new THREE.MeshLambertMaterial({ map: texTorchStick }),  // -X
    new THREE.MeshBasicMaterial({ color: 0xffdd33 }),       // +Y llama (auto-lit)
    new THREE.MeshLambertMaterial({ color: 0x3a1a04 }),     // -Y base
    new THREE.MeshLambertMaterial({ map: texTorchStick }),  // +Z
    new THREE.MeshLambertMaterial({ map: texTorchStick }),  // -Z
  ],
};

// ═══════════════════════════════════════════════════════════════
//  🗺️  ALMACÉN DEL MUNDO
// ═══════════════════════════════════════════════════════════════
export const blockMap = new Map();
let meshCache = [], cacheDirty = true;

const blockKey = (x, y, z) => `${x},${y},${z}`;
export const hasBlock = (x, y, z) => blockMap.has(blockKey(x, y, z));
export const getBlock = (x, y, z) => blockMap.get(blockKey(x, y, z)) ?? null;

export function addBlock(x, y, z, type = 'grass') {
  const key = blockKey(x, y, z);
  if (blockMap.has(key)) return;

  let mesh;

  if (type === 'torch') {
    // ── Geometría especial: palo fino 0.2 × 0.6 × 0.2 ─────────────
    //
    //  POSICIONAMIENTO VERTICAL:
    //  El bloque virtual tiene su centro en (x, y, z) y su suelo en y-0.5.
    //  La antorcha mide 0.6 de alto → su centro debe estar a:
    //    y_centro = (y - 0.5) + 0.6/2  =  y - 0.2
    //  Con esto la base del palo toca exactamente el suelo del bloque.
    //
    //  POINTLIGHT — gestión de memoria:
    //  La luz se añade directamente a la escena (no al mesh) para que
    //  Three.js la incluya en el frustum culling y shadow mapping de
    //  forma independiente. Se guarda en userData.pointLight para poder
    //  eliminarla limpiamente en removeBlock sin iterar toda la escena.
    const torchGeo = new THREE.BoxGeometry(0.2, 0.6, 0.2);
    mesh = new THREE.Mesh(torchGeo, MATERIALS.torch);
    mesh.position.set(x, y - 0.2, z);      // base sobre el suelo virtual
    mesh.castShadow    = false;              // sombra de un palo de 20cm: innecesaria
    mesh.receiveShadow = false;

    // Luz puntual naranja cálido — origen en la punta de la llama
    //   Punta del palo: (y - 0.2) + 0.3 = y + 0.1
    const ptLight = new THREE.PointLight(
      0xffaa00,   // color: naranja cálido
      1.5,        // intensidad
      12,         // distancia de alcance (bloques)
      1.5         // decay cuadrático → caída más natural
    );
    ptLight.position.set(x, y + 0.3, z);   // un poco por encima de la llama
    _scene.add(ptLight);

    // Guardar referencia: removeBlock la usará para limpiar la luz
    mesh.userData.pointLight = ptLight;

  } else {
    // ── Bloque estándar 1×1×1 ──────────────────────────────────────
    mesh = new THREE.Mesh(BLOCK_GEO, MATERIALS[type] ?? MATERIALS.dirt);
    mesh.position.set(x, y, z);
    mesh.castShadow    = true;
    mesh.receiveShadow = true;
  }

  mesh.userData.blockPos  = { x, y, z };
  mesh.userData.blockType = type;
  _scene.add(mesh);
  blockMap.set(key, mesh);
  cacheDirty = true;
}

export function removeBlock(x, y, z) {
  const mesh = blockMap.get(blockKey(x, y, z));
  if (!mesh) return;

  // ── Gestión de memoria para antorchas ────────────────────────────
  //
  //  PROBLEMA SIN ESTE CÓDIGO:
  //  Si sólo hacemos scene.remove(mesh), la PointLight queda huérfana
  //  en la escena: Three.js la sigue evaluando cada frame (coste de
  //  shading), se sigue incluyendo en shadow maps y el GC no puede
  //  reclamarla porque la escena mantiene una referencia viva.
  //
  //  SOLUCIÓN: eliminamos la luz ANTES de quitar el mesh, y llamamos
  //  dispose() para liberar los recursos WebGL (FBO de sombras, etc.)
  if (mesh.userData.pointLight) {
    _scene.remove(mesh.userData.pointLight);          // sacar de la escena
    mesh.userData.pointLight.dispose?.();             // liberar recursos GPU
    mesh.userData.pointLight = null;                  // romper la referencia JS
  }

  _scene.remove(mesh);
  blockMap.delete(blockKey(x, y, z));
  cacheDirty = true;
}

export function getBlockMeshes() {
  if (cacheDirty) { meshCache = Array.from(blockMap.values()); cacheDirty = false; }
  return meshCache;
}

// ═══════════════════════════════════════════════════════════════
//  🌍  GENERACIÓN DEL MUNDO
// ═══════════════════════════════════════════════════════════════
export function generateWorld() {
  const N = CONFIG.WORLD_SIZE;
  for (let x = 0; x < N; x++)
    for (let z = 0; z < N; z++)
      addBlock(x, 0, z, 'grass');
}