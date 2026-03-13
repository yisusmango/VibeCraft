// ═══════════════════════════════════════════════════════════════
//  src/SkinModel.js  —  Modelo de jugador estilo Minecraft 64×64
//  ─────────────────────────────────────────────────────────────
//  Exporta:
//    createPlayerModel(skinSource) → THREE.Group
//
//  El Group contiene 6 Mesh con sus UVs remapeados a la plantilla
//  clásica de Minecraft Java 64×64.  Si skinSource es null se usa
//  MeshLambertMaterial verde de fallback.
//
//  ─── SISTEMA DE COORDENADAS UV DE MINECRAFT 64×64 ──────────────
//
//  En la imagen PNG (origen arriba-izquierda):
//    x avanza hacia la derecha  (0 … 64)
//    y avanza hacia abajo       (0 … 64)
//
//  En Three.js (origen abajo-izquierda):
//    U = px / 64
//    V = 1 - py / 64          (py en píxeles desde arriba)
//
//  Para cada BoxGeometry(w, h, d) Three.js genera 6 caras en este
//  orden fijo de índices de face (grupo de 2 triángulos → 4 vértices):
//
//    face 0 → +X  (right)     face 1 → −X  (left)
//    face 2 → +Y  (top)       face 3 → −Y  (bottom)
//    face 4 → +Z  (front)     face 5 → −Z  (back)
//
//  Cada cara tiene 4 UVs en el array plano buffer[uv], empezando en
//  faceIndex * 4.  El orden de vértices por cara es:
//
//    v0 = bottom-left   v1 = bottom-right
//    v2 = top-left      v3 = top-right
//
//  CONVENCIÓN DE FLIP para BoxGeometry r158:
//  • +X / −X (right/left): flipU = true — Three.js genera U izq→der
//    mirando desde afuera, pero en el atlas las caras laterales están
//    espejadas respecto a esa convención.
//  • +Y (top): flipV = true — el eje V de Three.js corre en −Z pero
//    el atlas MC corre en +Z.
//  • −Y (bottom): sin flip — ya coincide.
//  • +Z / −Z (front/back): sin flip — U coincide izq→der con el atlas.
//
//  ─── LAYOUT ATLAS MC 64×64 ─────────────────────────────────────
//
//  mcFaceUVs(ox, oy, w, d, h) calcula los 6 rectángulos a partir del
//  origen del "cubo atlas" en la plantilla MC:
//    top:    (ox+d,       oy,    ox+d+w,     oy+d   )
//    bottom: (ox+d+w,     oy,    ox+d+w+w,   oy+d   )
//    right:  (ox,         oy+d,  ox+d,       oy+d+h )
//    front:  (ox+d,       oy+d,  ox+d+w,     oy+d+h )
//    left:   (ox+d+w,     oy+d,  ox+d+w+d,   oy+d+h )
//    back:   (ox+d+w+d,   oy+d,  ox+d+w+d+w, oy+d+h )
//
//  Partes y orígenes en el atlas:
//    head  : mcFaceUVs(0,  0,  8, 8, 8 )
//    body  : mcFaceUVs(16, 16, 8, 4, 12)
//    legR  : mcFaceUVs(0,  16, 4, 4, 12)
//    legL  : mcFaceUVs(16, 48, 4, 4, 12)   ← segunda capa (1.8 format)
//    armR  : mcFaceUVs(40, 16, 4, 4, 12)
//    armL  : mcFaceUVs(32, 48, 4, 4, 12)   ← segunda capa
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';

// ── Constante del atlas ──────────────────────────────────────────
const T = 64;   // tamaño de la textura en píxeles

// ═══════════════════════════════════════════════════════════════
//  remapUVs(geo, faceUVs)
//
//  Reescribe el BufferAttribute 'uv' de una BoxGeometry para que
//  cada una de las 6 caras apunte al rectángulo correcto del atlas.
//
//  @param {THREE.BoxGeometry} geo
//  @param {Array<{x0,y0,x1,y1,flipU?,flipV?}>} faceUVs
//    Índice 0 = +X, 1 = −X, 2 = +Y, 3 = −Y, 4 = +Z, 5 = −Z
//    Coordenadas en píxeles atlas (origen arriba-izquierda).
//    flipU invierte horizontalmente la cara, flipV verticalmente.
//
//  BoxGeometry r158 almacena los UVs con 4 vértices por cara.
//  El orden de vértices dentro de la cara es siempre:
//    [0] bottom-left  [1] bottom-right
//    [2] top-left     [3] top-right
// ═══════════════════════════════════════════════════════════════

function remapUVs(geo, faceUVs) {
  const uvAttr = geo.attributes.uv;
  const arr    = uvAttr.array;   // Float32Array, longitud = nVertices * 2

  for (let fi = 0; fi < 6; fi++) {
    const { x0, y0, x1, y1, flipU = false, flipV = false } = faceUVs[fi];

    // Convertir píxeles atlas a UV normalizados [0,1]
    // Eje V: invertir Y porque PNG tiene origen arriba, Three.js abajo
    const uMin = x0 / T;
    const uMax = x1 / T;
    const vMin = 1 - y1 / T;   // y1 (más abajo en PNG)  → vMin (más abajo en UV)
    const vMax = 1 - y0 / T;   // y0 (más arriba en PNG) → vMax (más arriba en UV)

    // Esquinas sin flip:
    //   v0 (bottom-left)  = (uMin, vMin)
    //   v1 (bottom-right) = (uMax, vMin)
    //   v2 (top-left)     = (uMin, vMax)
    //   v3 (top-right)    = (uMax, vMax)
    const corners = [
      [uMin, vMax],   // 0: top-left
      [uMax, vMax],   // 1: top-right
      [uMin, vMin],   // 2: bottom-left
      [uMax, vMin],   // 3: bottom-right
    ];

    if (flipU) {
      [corners[0][0], corners[1][0]] = [corners[1][0], corners[0][0]];
      [corners[2][0], corners[3][0]] = [corners[3][0], corners[2][0]];
    }
    if (flipV) {
      [corners[0][1], corners[2][1]] = [corners[2][1], corners[0][1]];
      [corners[1][1], corners[3][1]] = [corners[3][1], corners[1][1]];
    }

    const base = fi * 4 * 2;   // offset en el Float32Array (4 verts × 2 floats)
    for (let vi = 0; vi < 4; vi++) {
      arr[base + vi * 2]     = corners[vi][0];
      arr[base + vi * 2 + 1] = corners[vi][1];
    }
  }

  uvAttr.needsUpdate = true;
}

// ═══════════════════════════════════════════════════════════════
//  mcFaceUVs(ox, oy, w, d, h) → Array[6]
//
//  Genera los 6 descriptores de cara para una parte del cuerpo a
//  partir de su origen en el atlas MC y sus dimensiones en píxeles.
//
//  @param {number} ox  píxel X superior-izquierdo del bloque atlas
//  @param {number} oy  píxel Y superior-izquierdo del bloque atlas
//  @param {number} w   ancho  del cubo en píxeles (eje X del jugador)
//  @param {number} d   profundidad del cubo en píxeles (eje Z)
//  @param {number} h   altura  del cubo en píxeles (eje Y)
//
//  Orden resultado: [+X=right, −X=left, +Y=top, −Y=bottom, +Z=front, −Z=back]
// ═══════════════════════════════════════════════════════════════

function mcFaceUVs(ox, oy, w, d, h) {
  return [
    // +X  right   — espejado en atlas → flipU
    { x0: ox,             y0: oy + d,  x1: ox + d,               y1: oy + d + h, flipU: true  },
    // −X  left    — espejado en atlas → flipU
    { x0: ox + d + w,     y0: oy + d,  x1: ox + d + w + d,       y1: oy + d + h, flipU: true  },
    // +Y  top     — eje V corre en −Z en Three.js, +Z en atlas → flipV
    { x0: ox + d,         y0: oy,      x1: ox + d + w,           y1: oy + d,     flipV: true  },
    // −Y  bottom  — ya coincide, sin flip
    { x0: ox + d + w,     y0: oy,      x1: ox + d + w + w,       y1: oy + d,     flipV: false },
    // +Z  back    — el jugador mira hacia -Z, así que +Z es la espalda
    { x0: ox + d + w + d, y0: oy + d,  x1: ox + d + w + d + w,   y1: oy + d + h, flipU: false },
    // −Z  front   — -Z es la cara/frente del jugador
    { x0: ox + d,         y0: oy + d,  x1: ox + d + w,           y1: oy + d + h, flipU: false },
  ];
}

// ── Descriptores atlas para cada parte del cuerpo ───────────────
//   mcFaceUVs(ox, oy, w, d, h)
const UV_HEAD = mcFaceUVs(0,  0,  8, 8, 8);    // cabeza  8×8×8   @ (0,0)
const UV_BODY = mcFaceUVs(16, 16, 8, 4, 12);   // torso   8×4×12  @ (16,16)
const UV_LEGR = mcFaceUVs(0,  16, 4, 4, 12);   // pierna derecha  @ (0,16)
const UV_LEGL = mcFaceUVs(16, 48, 4, 4, 12);   // pierna izq (segunda capa) @ (16,48)
const UV_ARMR = mcFaceUVs(40, 16, 3, 4, 12);   // brazo derecho   @ (40,16)
const UV_ARML = mcFaceUVs(32, 48, 3, 4, 12);   // brazo izq (segunda capa)  @ (32,48)

// ═══════════════════════════════════════════════════════════════
//  createPlayerModel(skinSource) → THREE.Group
//
//  @param {string|null} skinSource — Data URL Base64 PNG o null
//  @returns {THREE.Group}  grupo listo para añadir a la escena
//
//  Proporciones en unidades Three.js (escala: 1px MC = 0.0625u):
//    Cabeza  : 0.50 × 0.50 × 0.50   (8px × 0.0625)
//    Torso   : 0.50 × 0.75 × 0.25   (8×12×4 px)
//    Pierna  : 0.25 × 0.75 × 0.25   (4×12×4 px)
//    Brazo   : 0.1875×0.75×0.25     (3×12×4 px — formato Slim/Alex)
//
//  Altura total del grupo: 2.0u → escalado a 0.9 → 1.8u
//  (coincide con el AABB del jugador local).
//
//  ─── SISTEMA DE PIVOTES ─────────────────────────────────────────
//  La geometría de cada parte se desplaza con geo.translate() para
//  que el origen local de la malla coincida con la articulación:
//
//    head  → pivot en cuello  (bottom):  geo.translate(0, +HEAD_H/2, 0)
//            malla en Y=1.50  → geometría ocupa [1.50 … 2.00]
//    body  → pivot en cadera  (bottom):  geo.translate(0, +BODY_H/2, 0)
//            malla en Y=0.75  → geometría ocupa [0.75 … 1.50]
//    legR/L→ pivot en cadera  (top):     geo.translate(0, -LEG_H/2,  0)
//            malla en Y=0.75  → geometría ocupa [0.00 … 0.75]
//    armR/L→ pivot en hombro  (top):     geo.translate(0, -ARM_H/2,  0)
//            malla en Y=1.50  → geometría ocupa [0.75 … 1.50]
//
//  Los huesos se exponen en group.userData para animación externa:
//    { head, body, armR, armL, legR, legL }
// ═══════════════════════════════════════════════════════════════

export function createPlayerModel(skinSource) {

  // ── Material ──────────────────────────────────────────────────
  let mat;
  if (skinSource) {
    const tex = new THREE.TextureLoader().load(skinSource);
    tex.magFilter  = THREE.NearestFilter;
    tex.minFilter  = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    mat = new THREE.MeshLambertMaterial({ map: tex, transparent: false });
  } else {
    mat = new THREE.MeshLambertMaterial({ color: 0x2e7d32 });  // verde fallback
  }

  // ── Grupo raíz ────────────────────────────────────────────────
  const group = new THREE.Group();

  // ── Helper: construir una parte con BoxGeometry + pivote + UV remap ──
  //  pivotShiftY desplaza la geometría en Y para que el origen de la
  //  malla quede en la articulación en lugar del centro geométrico:
  //    +HEAD_H/2  → geometría sube → origen queda en el borde inferior (cuello)
  //    -LEG_H/2   → geometría baja → origen queda en el borde superior (cadera)
  //  posY es la posición final de la malla (la articulación) en Y del grupo.
  function makePart(w, h, d, faceUVs, posY, pivotShiftY) {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (pivotShiftY !== 0) geo.translate(0, pivotShiftY, 0);
    remapUVs(geo, faceUVs);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = posY;
    mesh.castShadow = true;
    return mesh;
  }

  // ── Medidas (unidades Three.js) ───────────────────────────────
  const HEAD_W = 0.50,   HEAD_H = 0.50,  HEAD_D = 0.50;
  const BODY_W = 0.50,   BODY_H = 0.75,  BODY_D = 0.25;
  const LEG_W  = 0.25,   LEG_H  = 0.75,  LEG_D  = 0.25;
  const ARM_W  = 0.1875, ARM_H  = 0.75,  ARM_D  = 0.25;   // Slim/Alex 3px

  // ── Construcción de partes con pivotes en articulaciones ──────
  //
  //  head : pivot cuello  (bottom) → geo sube +HEAD_H/2 → malla en Y=1.50
  //  body : pivot cadera  (bottom) → geo sube +BODY_H/2 → malla en Y=0.75
  //  legs : pivot cadera  (top)    → geo baja -LEG_H/2  → malla en Y=0.75
  //  arms : pivot hombro  (top)    → geo baja -ARM_H/2  → malla en Y=1.50
  const head = makePart(HEAD_W, HEAD_H, HEAD_D, UV_HEAD, 1.50,        +HEAD_H / 2);
  const body = makePart(BODY_W, BODY_H, BODY_D, UV_BODY, 0.75,        +BODY_H / 2);
  const legR = makePart(LEG_W,  LEG_H,  LEG_D,  UV_LEGR, LEG_H,       -LEG_H  / 2);
  const legL = makePart(LEG_W,  LEG_H,  LEG_D,  UV_LEGL, LEG_H,       -LEG_H  / 2);
  const armR = makePart(ARM_W,  ARM_H,  ARM_D,  UV_ARMR, 0.75 + BODY_H, -ARM_H / 2);
  const armL = makePart(ARM_W,  ARM_H,  ARM_D,  UV_ARML, 0.75 + BODY_H, -ARM_H / 2);

  // ── Desplazamientos X ─────────────────────────────────────────
  legR.position.x =  (LEG_W  / 2) + 0.001;
  legL.position.x = -(LEG_W  / 2) - 0.001;
  armR.position.x =  (BODY_W / 2) + (ARM_W / 2);
  armL.position.x = -(BODY_W / 2) - (ARM_W / 2);

  group.add(head, body, legR, legL, armR, armL);

  // ── Escalar al AABB del jugador (altura 1.8u) ─────────────────
  group.scale.setScalar(0.9);

  // ── Exponer huesos para animación externa ──────────────────────
  //  multiplayer.js accede a estas referencias en updateOtherPlayers()
  //  para aplicar walk swing y head pitch sin necesidad de buscar hijos.
  group.userData = { head, body, armR, armL, legR, legL };

  return group;
}