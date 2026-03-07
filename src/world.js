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

/**
 * Devuelve el tipo (string) del bloque en (x,y,z), o null si no existe.
 * Usado por player.js para distinguir bloques sólidos de no sólidos
 * sin iterar el mapa entero — coste O(1) gracias al Map.
 * @returns {string|null}  ej. 'grass' | 'torch' | null
 */
export function getBlockType(x, y, z) {
  const mesh = blockMap.get(blockKey(x, y, z));
  return mesh ? mesh.userData.blockType : null;
}

export function addBlock(x, y, z, type = 'grass', normal = null) {
  const key = blockKey(x, y, z);
  if (blockMap.has(key)) return;

  let mesh;

  if (type === 'torch') {
    // ═══════════════════════════════════════════════════════════
    //  🔦  LÓGICA DE COLOCACIÓN DE ANTORCHAS
    //  ─────────────────────────────────────────────────────────
    //  La antorcha tiene tres modos según la cara golpeada (normal):
    //
    //    (0,+1, 0)  → SUELO   : vertical, centrada en la celda
    //    (0,-1, 0)  → TECHO   : PROHIBIDO → return sin colocar
    //    (±1, 0, 0) → PARED X : inclinada ±30° en Z, pegada a pared X
    //    (0, 0,±1)  → PARED Z : inclinada ±30° en X, pegada a pared Z
    //
    //  GEOMETRÍA DE REFERENCIA:
    //  BoxGeometry(0.2, 0.6, 0.2) → palo de 0.6 unidades en +Y.
    //  En espacio local:  base = (0, -0.3, 0), llama = (0, +0.3, 0).
    //
    //  MATH DE INCLINACIÓN (pared eje X, normal +X):
    //  ─────────────────────────────────────────────
    //  Queremos que el palo se incline 30° (π/6) alejándose de la pared.
    //  rotation.z = −π/6 → el extremo +Y (llama) se desplaza en +X:
    //    Δx_llama =  0.3 × sin(π/6) = +0.15  (alejándose de pared)
    //    Δy_llama =  0.3 × cos(π/6) = +0.26
    //    Δx_base  = −0.3 × sin(π/6) = −0.15  (entrando en pared)
    //    Δy_base  = −0.3 × cos(π/6) = −0.26
    //
    //  Para que la BASE quede justo sobre la superficie de la pared
    //  (en x = nx − 0.5):
    //    pos.x_base = pos.x_centro + Δx_base = nx − 0.5
    //    → pos.x_centro = nx − 0.5 + 0.15 = nx − 0.35
    //
    //  Para Y: la antorcha aparece en el tercio superior del bloque,
    //  como en Minecraft. El centro del palo queda a nx-0.15 de altura
    //  sobre el suelo del bloque (y − 0.5), es decir:
    //    pos.y_centro = (y − 0.5) + 0.3 + Δy_base_corr ≈ y − 0.15
    //
    //  La misma lógica simétrica se aplica para −X, +Z, −Z.
    //  ─────────────────────────────────────────────────────────
    //
    //  POSICIÓN DE LA POINTLIGHT (llama):
    //  llama_world = pos_centro + rotate(TILT, [0,+0.3,0])
    //  Para simplificar usamos una aproximación que es visualmente
    //  precisa:  offset ≈ 0.18 en el eje del normal, 0.10 en Y.

    // ── Techo: prohibido ────────────────────────────────────────
    if (normal && normal.y === -1) return;   // cancela silenciosamente

    const TILT       = Math.PI / 6;   // 30°
    const WALL_OFF   = 0.35;          // offset del centro hacia la pared
    const WALL_Y     = y - 0.15;      // altura centro para pared

    const torchGeo = new THREE.BoxGeometry(0.2, 0.6, 0.2);
    mesh = new THREE.Mesh(torchGeo, MATERIALS.torch);
    mesh.castShadow    = false;
    mesh.receiveShadow = false;

    // Posición y rotación según la normal de la cara golpeada
    let lightX = x, lightY = y + 0.15, lightZ = z;

    if (!normal || normal.y === 1) {
      // ── Suelo: vertical ────────────────────────────────────────
      //   Centro del palo a y−0.2 → base en y−0.5 (suelo de celda)
      mesh.position.set(x, y - 0.2, z);
      // rotation queda (0,0,0) por defecto
      lightX = x;   lightY = y + 0.12;   lightZ = z;

    } else if (normal.x === 1) {
      // ── Pared +X : base en x−0.5, inclina hacia +X ─────────────
      mesh.position.set(x - WALL_OFF, WALL_Y, z);
      mesh.rotation.z = -TILT;                // cima del palo → +X
      lightX = x - 0.15;   lightY = y + 0.08;

    } else if (normal.x === -1) {
      // ── Pared −X : base en x+0.5, inclina hacia −X ─────────────
      mesh.position.set(x + WALL_OFF, WALL_Y, z);
      mesh.rotation.z = TILT;                 // cima del palo → −X
      lightX = x + 0.15;   lightY = y + 0.08;

    } else if (normal.z === 1) {
      // ── Pared +Z : base en z−0.5, llama se aleja hacia +Z ─────────
      //
      //  BUG ANTERIOR: rotation.x = -TILT hacía que la llama apuntase
      //  hacia -Z (¡hacia la pared!). Con rotation.x = -θ alrededor de X:
      //    Z_llama = +0.3 × sin(-π/6) = -0.15  → llama hacia -Z  ✗
      //
      //  CORRECCIÓN: rotation.x = +TILT → llama hacia +Z:
      //    Z_llama = +0.3 × sin(+π/6) = +0.15  → llama hacia +Z  ✓
      //    Z_base  = -0.3 × sin(+π/6) = -0.15  → base  hacia -Z
      //    base_world_z = (z - WALL_OFF) + (-0.15) = z - 0.50  ✓
      mesh.position.set(x, WALL_Y, z - WALL_OFF);
      mesh.rotation.x = +TILT;               // ← era -TILT (invertido)
      lightZ = z - 0.20;   lightY = y + 0.10;

    } else if (normal.z === -1) {
      // ── Pared −Z : base en z+0.5, llama se aleja hacia −Z ─────────
      //
      //  BUG ANTERIOR: rotation.x = +TILT → llama hacia +Z (hacia pared). ✗
      //  CORRECCIÓN:   rotation.x = -TILT → llama hacia -Z            ✓
      //    Z_llama = +0.3 × sin(-π/6) = -0.15  → hacia -Z  ✓
      //    Z_base  = -0.3 × sin(-π/6) = +0.15
      //    base_world_z = (z + WALL_OFF) + 0.15 = z + 0.50           ✓
      mesh.position.set(x, WALL_Y, z + WALL_OFF);
      mesh.rotation.x = -TILT;               // ← era +TILT (invertido)
      lightZ = z + 0.20;   lightY = y + 0.10;
    }

    // PointLight en la posición aproximada de la llama
    const ptLight = new THREE.PointLight(
      0xffaa00,   // naranja cálido
      1.5,        // intensidad
      12,         // distancia (bloques)
      1.5         // decay cuadrático
    );
    ptLight.position.set(lightX, lightY, lightZ);
    _scene.add(ptLight);
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