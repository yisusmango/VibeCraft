// ═══════════════════════════════════════════════════════════════
//  src/environment.js
//  Responsabilidades:
//    • Ciclo de día y noche (paleta de colores para cielo, niebla,
//      ambientLight y sunLight interpolados con lerp)
//    • Sol y Luna visibles: geometría con texturas procedurales,
//      pivote que rota sobre el eje X y sigue al jugador
//    • Nubes 3D volumétricas: InstancedMesh de cajas planas con
//      wrap-around relativo a la cámara para cielo infinito
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';

// ═══════════════════════════════════════════════════════════════
//  ⏱️  CONSTANTES DE TIEMPO
//  ─────────────────────────────────────────────────────────────
//  DAY_DURATION  → duración de un ciclo completo en segundos reales.
//                  1200 s = 20 minutos; igual que el juego original.
//  Las 4 fases se distribuyen uniformemente cada 0.25 del ciclo:
//    0.00 → Amanecer   (dawn)
//    0.25 → Mediodía   (noon)
//    0.50 → Atardecer  (dusk)
//    0.75 → Medianoche (midnight)
// ═══════════════════════════════════════════════════════════════
// ── [BUGFIX 2] ── Ciclo de 20 minutos reales (1200 s).
//   Antes estaba en 120 s (2 min) útil para desarrollo.
//   Cambia a 60 para testing rápido, a 1200 para producción.
const DAY_DURATION  = 1200;  // segundos reales por ciclo completo

// ─── Tabla de stops del ciclo día/noche ────────────────────────
//
//  PROBLEMA ANTERIOR: con 4 keyframes equidistantes, la interpolación
//  lineal hacía que la noche (35%) se fuera aclarando continuamente
//  desde el primer segundo, y el día (50%) fuera perdiendo color todo
//  el rato hacia el atardecer.
//
//  SOLUCIÓN — 6 stops con "plateaus" duplicados:
//
//  ┌─────┬────────┬──────────────────────────────────────────────────┐
//  │ idx │  dayT  │ Descripción                                      │
//  ├─────┼────────┼──────────────────────────────────────────────────┤
//  │  0  │ 0.000  │ AMANECER — inicio transición amanecer→día (7.5%) │
//  │  1  │ 0.075  │ DÍA START — plateau comienza (mismos colores…)   │
//  │  2  │ 0.575  │ DÍA END   — …que stop 1 → 50% sin cambio visual  │
//  │  3  │ 0.613  │ ATARDECER — pico naranja de la transición (7.5%) │
//  │  4  │ 0.650  │ NOCHE START — plateau comienza (mismos colores…) │
//  │  5  │ 0.925  │ NOCHE END   — …que stop 4 → 35% sin cambio visual│
//  │     │ (1.000)│ → wrap al stop 0: transición noche→amanecer 7.5% │
//  └─────┴────────┴──────────────────────────────────────────────────┘
//
//  Duración de cada tramo:
//    0.000→0.075 = 7.5%  → amanecer   1.5 min ✓
//    0.075→0.575 = 50%   → día       10.0 min ✓  (plateau: color fijo)
//    0.575→0.650 = 7.5%  → atardecer  1.5 min ✓  (pico naranja a t=0.613)
//    0.650→0.925 = 27.5% → noche      5.5 min ✓  (plateau: color fijo)
//    0.925→1.000 = 7.5%  → amanecer   1.5 min ✓  (se cierra el ciclo)
//    Total noche + dawn = 35% = 7 min ✓
//
//  La clave: stops 1 y 2 tienen colores idénticos → lerp = 0 cambio.
//            stops 4 y 5 tienen colores idénticos → lerp = 0 cambio.

// ── Colores reutilizados para los plateaus (evita objetos duplicados) ─
const _noonSky     = new THREE.Color(0x87CEEB);
const _noonFog     = new THREE.Color(0x87CEEB);
const _noonAmbient = new THREE.Color(0xffffff);
const _noonSun     = new THREE.Color(0xfffbe0);
const _noonCloud   = new THREE.Color(0xffffff);

const _nightSky     = new THREE.Color(0x080c18);
const _nightFog     = new THREE.Color(0x0a0f20);
const _nightAmbient = new THREE.Color(0x1a2844);
const _nightSun     = new THREE.Color(0x4466aa);
const _nightCloud   = new THREE.Color(0x1e2233);

const PHASE_ORDER = [

  // ── Stop 0 ─ AMANECER: inicio de la transición al día ─────────
  { t: 0.000,
    sky: new THREE.Color(0xffb347), fog: new THREE.Color(0xff9966),
    ambient: new THREE.Color(0xffa070), sun: new THREE.Color(0xffe0aa),
    sunIntensity: 0.45, ambientIntensity: 0.40,
    cloud: new THREE.Color(0xffbb88),        // rosado-naranja amanecer
  },

  // ── Stop 1 ─ DÍA (plateau START) ──────────────────────────────
  { t: 0.075,
    sky: _noonSky, fog: _noonFog, ambient: _noonAmbient, sun: _noonSun,
    sunIntensity: 0.90, ambientIntensity: 0.55,
    cloud: _noonCloud,                       // blanco puro
  },

  // ── Stop 2 ─ DÍA (plateau END — colores IDÉNTICOS al stop 1) ──
  //  Efecto: el lerp entre stop 1 y stop 2 no produce cambio visual.
  //  El color del cielo permanece azul-cielo fijo durante 50%.
  { t: 0.575,
    sky: _noonSky, fog: _noonFog, ambient: _noonAmbient, sun: _noonSun,
    sunIntensity: 0.90, ambientIntensity: 0.55,
    cloud: _noonCloud,
  },

  // ── Stop 3 ─ ATARDECER: pico de la transición (mitad de 7.5%) ─
  //  La transición ocupa 0.575→0.650 (7.5%).
  //  Este stop en t=0.613 es el pico de naranja; el cielo sube al
  //  rojo-naranja y luego baja rápidamente hacia el azul nocturno.
  { t: 0.613,
    sky: new THREE.Color(0xff6030), fog: new THREE.Color(0xff7755),
    ambient: new THREE.Color(0xff8844), sun: new THREE.Color(0xffaa55),
    sunIntensity: 0.35, ambientIntensity: 0.30,
    cloud: new THREE.Color(0xff9966),        // naranja encendido
  },

  // ── Stop 4 ─ NOCHE (plateau START) ────────────────────────────
  { t: 0.650,
    sky: _nightSky, fog: _nightFog, ambient: _nightAmbient, sun: _nightSun,
    sunIntensity: 0.00, ambientIntensity: 0.12,
    cloud: _nightCloud,                      // gris-azul oscuro
  },

  // ── Stop 5 ─ NOCHE (plateau END — colores IDÉNTICOS al stop 4) ─
  //  Efecto: el lerp entre stop 4 y stop 5 no produce cambio visual.
  //  El cielo permanece oscuro durante 27.5%.
  //  Tras este stop, el ciclo hace wrap a stop 0 (t→1.0 = dawn),
  //  produciendo la transición final noche→amanecer de 7.5%.
  { t: 0.925,
    sky: _nightSky, fog: _nightFog, ambient: _nightAmbient, sun: _nightSun,
    sunIntensity: 0.00, ambientIntensity: 0.12,
    cloud: _nightCloud,
  },

];

// ═══════════════════════════════════════════════════════════════
//  🌞  TEXTURA PROCEDURAL DEL SOL
//  Cuadrado amarillo brillante con halo y brillo central.
// ═══════════════════════════════════════════════════════════════
function makeSunTexture() {
  const size   = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx    = canvas.getContext('2d');

  // Halo exterior: gradiente radial desde blanco opaco al transparente
  const halo = ctx.createRadialGradient(
    size / 2, size / 2, size * 0.15,
    size / 2, size / 2, size * 0.50
  );
  halo.addColorStop(0,   'rgba(255, 240, 120, 1.0)');
  halo.addColorStop(0.55,'rgba(255, 200,  40, 0.85)');
  halo.addColorStop(1,   'rgba(255, 160,   0, 0.0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);

  // Núcleo cuadrado estilo pixel-art (3 capas concéntricas)
  const half = size / 2;
  ctx.fillStyle = 'rgba(255, 255, 200, 1.0)';
  ctx.fillRect(half - 10, half - 10, 20, 20);
  ctx.fillStyle = 'rgba(255, 255, 255, 1.0)';
  ctx.fillRect(half -  6, half -  6, 12, 12);
  ctx.fillStyle = 'rgba(255, 250, 220, 1.0)';
  ctx.fillRect(half -  3, half -  3,  6,  6);

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

// ═══════════════════════════════════════════════════════════════
//  🌕  TEXTURA PROCEDURAL DE LA LUNA
//  Cuadrado gris/blanco con cráteres simulados con pixel noise.
// ═══════════════════════════════════════════════════════════════
function makeMoonTexture() {
  const size   = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx    = canvas.getContext('2d');

  // Halo suave (más difuso que el sol)
  const halo = ctx.createRadialGradient(
    size / 2, size / 2, size * 0.12,
    size / 2, size / 2, size * 0.50
  );
  halo.addColorStop(0,   'rgba(220, 225, 240, 0.90)');
  halo.addColorStop(0.45,'rgba(180, 185, 210, 0.60)');
  halo.addColorStop(1,   'rgba(100, 110, 150, 0.0)');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);

  // Cuerpo de la luna
  const half = size / 2;
  ctx.fillStyle = 'rgba(210, 215, 230, 1.0)';
  ctx.fillRect(half - 10, half - 10, 20, 20);
  ctx.fillStyle = 'rgba(235, 238, 248, 1.0)';
  ctx.fillRect(half -  6, half -  6, 12, 12);

  // Cráteres pixel-art (oscuros, irregulares)
  const craters = [
    [half - 4, half - 4, 3, 3],
    [half + 2, half - 2, 2, 2],
    [half - 2, half + 3, 2, 2],
  ];
  ctx.fillStyle = 'rgba(150, 155, 175, 0.85)';
  craters.forEach(([x, y, w, h]) => ctx.fillRect(x, y, w, h));

  const tex = new THREE.CanvasTexture(canvas);
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

// ═══════════════════════════════════════════════════════════════
//  🌍  CLASE PRINCIPAL Environment
// ═══════════════════════════════════════════════════════════════

export class Environment {
  /**
   * @param {THREE.Scene}            scene        — Escena Three.js
   * @param {THREE.AmbientLight}     ambientLight — Luz ambiental global
   * @param {THREE.DirectionalLight} sunLight     — Luz solar/direccional
   */
  constructor(scene, ambientLight, sunLight) {
    this._scene        = scene;
    this._ambient      = ambientLight;
    this._sun          = sunLight;

    // Reloj interno: 0 → 1 en DAY_DURATION segundos
    this._dayT = 0.0;   // empieza en el amanecer

    // Colores interpolados actuales (reutilizados para evitar GC)
    this._curSky     = new THREE.Color();
    this._curFog     = new THREE.Color();
    this._curAmbient = new THREE.Color();
    this._curSun     = new THREE.Color();
    this._curCloud   = new THREE.Color();  // ← NUEVO: tinte interpolado de las nubes

    this._buildCelestials(scene);
    this._buildClouds(scene);
  }

  // ─────────────────────────────────────────────────────────────
  //  🔨  CONSTRUCCIÓN — Sol, Luna, Pivote y Nubes
  // ─────────────────────────────────────────────────────────────

  _buildCelestials(scene) {
    // Pivote: Object3D vacío que rota sobre el eje X
    this._pivot = new THREE.Object3D();
    scene.add(this._pivot);

    // ── Sol ──────────────────────────────────────────────────────
    //  Plano de 18×18 unidades con textura aditiva para brillar
    //  sin importar la iluminación de la escena.
    const sunGeo  = new THREE.PlaneGeometry(18, 18);
    const sunMat  = new THREE.MeshBasicMaterial({
      map:         makeSunTexture(),
      transparent: true,
      fog:         false,         // ← siempre visible, sin desvanecerse con la niebla
      depthWrite:  false,
      blending:    THREE.AdditiveBlending,  // brilla sobre el cielo
      side:        THREE.DoubleSide,
    });
    this._sunMesh = new THREE.Mesh(sunGeo, sunMat);
    // ── [BUGFIX 1] ── Ciclo invertido corregido.
    //   PROBLEMA: con rotation.x = dayT×2π, al mediodía (dayT=0.25)
    //   rotation.x = π/2. Un punto en local (0,0,+110) se transforma
    //   a mundo (0, -110, 0) → ¡bajo tierra! El sol y la luna estaban
    //   invertidos respecto al ciclo de color del cielo.
    //
    //   SOLUCIÓN: intercambiar los signos de Z.
    //   Con el sol en Z=-110, al mediodía (rotation.x=π/2):
    //     world_Y = -(-110)×sin(π/2) = +110  → SOL ARRIBA ✓
    //   Con la luna en Z=+110, a medianoche (rotation.x=3π/2):
    //     world_Y = -(+110)×sin(3π/2) = +110 → LUNA ARRIBA ✓
    this._sunMesh.position.set(0, 0, -110);   // ← era +110, ahora -110
    this._pivot.add(this._sunMesh);

    // ── Luna ─────────────────────────────────────────────────────
    const moonGeo  = new THREE.PlaneGeometry(12, 12);
    const moonMat  = new THREE.MeshBasicMaterial({
      map:         makeMoonTexture(),
      transparent: true,
      fog:         false,
      depthWrite:  false,
      blending:    THREE.NormalBlending,
      side:        THREE.DoubleSide,
    });
    this._moonMesh = new THREE.Mesh(moonGeo, moonMat);
    this._moonMesh.position.set(0, 0, 110);   // ← era -110, ahora +110
    this._pivot.add(this._moonMesh);
  }

  _buildClouds(scene) {
    // ── Nubes 3D — InstancedMesh ──────────────────────────────────
    //
    //  DISEÑO:
    //  • 1 sola draw call gracias a InstancedMesh (vs N draw calls con Mesh[])
    //  • BoxGeometry(1,1,1) base; la escala por instancia da el tamaño real.
    //    Cada nube tiene ancho ~8–18, alto ~1.5–3, prof ~6–14 unidades.
    //  • Rotación Y aleatoria para evitar que todas queden paralelas al eje Z.
    //  • MeshBasicMaterial: no responde a luces → color totalmente predecible.
    //    .color = _curCloud  → el tinte lo maneja _interpolatePhase() igual
    //    que antes, sin cambios en la interfaz pública.
    //
    //  WRAP-AROUND (cielo infinito):
    //  Cada frame avanzamos c.x += windSpeed * dt.
    //  Si una nube supera ±CLOUD_SPREAD respecto a la cámara (en X o Z),
    //  la teletransportamos al lado opuesto desplazando exactamente
    //  CLOUD_SPREAD*2 unidades para mantener la densidad uniforme.
    //
    //  RENDIMIENTO:
    //  48 instancias × BoxGeometry (12 tri) = 576 triángulos totales.
    //  Actualizar 48 matrices/frame es O(48) operaciones triviales.
    //  Impacto en FPS: ~0.

    const CLOUD_COUNT  = 48;
    const CLOUD_SPREAD = 110;    // radio del área cubierta (110 × 2 = 220 m)
    const CLOUD_Y      = 42;     // misma altura que las antiguas nubes 2D

    const cloudGeo = new THREE.BoxGeometry(1, 1, 1);
    const cloudMat = new THREE.MeshBasicMaterial({
      color:       0xffffff,    // blanco base; _interpolatePhase() lo tinta
      transparent: true,
      opacity:     0.82,
      fog:         false,       // siempre visibles, sin desvanecerse en la niebla
      depthWrite:  false,       // sin z-fighting entre nubes superpuestas
      side:        THREE.FrontSide,
    });

    this._cloudMesh = new THREE.InstancedMesh(cloudGeo, cloudMat, CLOUD_COUNT);
    // frustumCulled = false: el bounding box del InstancedMesh es el de la
    // geometría base (1×1×1), no el de las instancias escaladas, por lo que
    // Three.js lo descartaría erróneamente. Desactivar culling es seguro
    // porque con solo 576 triángulos no penaliza la GPU.
    this._cloudMesh.frustumCulled = false;
    scene.add(this._cloudMesh);

    // Datos de cada instancia (posición world + escala + rotación Y)
    this._cloudData   = [];
    this._cloudSpread = CLOUD_SPREAD;
    this._cloudDummy  = new THREE.Object3D();   // reutilizado cada frame

    for (let i = 0; i < CLOUD_COUNT; i++) {
      const x  = (Math.random() - 0.5) * CLOUD_SPREAD * 2;
      const z  = (Math.random() - 0.5) * CLOUD_SPREAD * 2;
      const sx = 8  + Math.random() * 10;   // ancho  8–18 u
      const sy = 1.5 + Math.random() * 1.5; // alto   1.5–3 u
      const sz = 6  + Math.random() * 8;    // prof   6–14 u
      const ry = Math.random() * Math.PI;   // rotación Y 0–180°

      this._cloudData.push({ x, y: CLOUD_Y, z, sx, sy, sz, ry });

      this._cloudDummy.position.set(x, CLOUD_Y, z);
      this._cloudDummy.scale.set(sx, sy, sz);
      this._cloudDummy.rotation.y = ry;
      this._cloudDummy.updateMatrix();
      this._cloudMesh.setMatrixAt(i, this._cloudDummy.matrix);
    }
    this._cloudMesh.instanceMatrix.needsUpdate = true;
  }

  // ─────────────────────────────────────────────────────────────
  //  🔄  ACTUALIZACIÓN — llamar cada frame desde animate()
  //  @param {number} dt      — Delta time en segundos
  //  @param {THREE.Camera} camera — Para seguir la posición XZ del jugador
  // ─────────────────────────────────────────────────────────────

  update(dt, camera) {
    // 1. Avanzar reloj: dayT en [0, 1) — módulo garantiza continuidad
    this._dayT = (this._dayT + dt / DAY_DURATION) % 1.0;

    // 2. Interpolar colores e intensidades entre las 4 fases
    this._interpolatePhase();

    // 3. Aplicar colores a la escena
    this._scene.background.copy(this._curSky);
    this._scene.fog.color.copy(this._curFog);
    this._ambient.color.copy(this._curAmbient);
    this._sun.color.copy(this._curSun);

    // 4. Rotar pivote: 1 vuelta completa (2π) en DAY_DURATION seg
    //    El eje de rotación es X, lo que hace que el sol suba/baje
    //    por el eje vertical (Y) de la escena.
    this._pivot.rotation.x = this._dayT * Math.PI * 2;

    // 5. Seguir la cámara en XZ para que el sol nunca "se aleje"
    const camPos = camera.parent
      ? camera.parent.position   // PointerLockControls: cámara hija del yaw object
      : camera.position;
    this._pivot.position.x = camPos.x;
    this._pivot.position.z = camPos.z;
    // Fijamos Y del pivote en 0 para que el eje de giro esté siempre al nivel del suelo
    this._pivot.position.y = 0;

    // 6. Hacer que Sol y Luna siempre miren a la cámara (billboarding)
    this._sunMesh.lookAt(camPos);
    this._moonMesh.lookAt(camPos);

    // 7. Mover nubes 3D con viento + wrap-around relativo a la cámara
    //
    //    Velocidad equivalente a la antigua textura 2D:
    //      Old: offset.x += 0.0048 UV/s × 55 m/UV = 0.264 m/s
    //    Mantenemos 0.264 u/s para que el ritmo visual sea idéntico.
    //
    //    Wrap: si c.x - camX supera ±CLOUD_SPREAD, la nube se tele-
    //    transporta CLOUD_SPREAD*2 unidades al lado opuesto.
    //    El mismo check en Z garantiza que las nubes también sigan al
    //    jugador cuando se mueve lateralmente.
    {
      const WIND = 0.264;        // unidades/seg
      const camX = camPos.x;
      const camZ = camPos.z;
      const wrap  = this._cloudSpread;

      for (let i = 0; i < this._cloudData.length; i++) {
        const c = this._cloudData[i];

        // Avanzar posición X (dirección del viento)
        c.x += WIND * dt;

        // Wrap-around en X respecto a la cámara
        if (c.x - camX >  wrap) c.x -= wrap * 2;
        if (c.x - camX < -wrap) c.x += wrap * 2;

        // Wrap-around en Z respecto a la cámara (no es viento, es seguimiento)
        if (c.z - camZ >  wrap) c.z -= wrap * 2;
        if (c.z - camZ < -wrap) c.z += wrap * 2;

        this._cloudDummy.position.set(c.x, c.y, c.z);
        this._cloudDummy.scale.set(c.sx, c.sy, c.sz);
        this._cloudDummy.rotation.y = c.ry;
        this._cloudDummy.updateMatrix();
        this._cloudMesh.setMatrixAt(i, this._cloudDummy.matrix);
      }
      this._cloudMesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  🌈  INTERPOLACIÓN DE FASES — corazón del ciclo día/noche
  //  ─────────────────────────────────────────────────────────────
  //  ALGORITMO (sin cambios respecto a la versión anterior):
  //  1. Buscamos entre qué dos stops consecutivos cae dayT.
  //  2. Calculamos un alpha local [0,1] entre esos dos stops.
  //  3. Interpolamos linealmente (lerp) cada componente.
  //
  //  El efecto "plateau" lo da el propio lerp: cuando dos stops
  //  consecutivos tienen colores idénticos, alpha puede valer 0–1
  //  y el resultado siempre es el mismo color → ningún cambio visual.
  //
  //  El ciclo es CIRCULAR: el último stop (t=0.925) interpola de
  //  vuelta al stop 0 (t=0.000/1.000).
  //  Solución: cuando phaseB.t < phaseA.t usamos tB = phaseB.t + 1.0.
  // ─────────────────────────────────────────────────────────────

  _interpolatePhase() {
    const t   = this._dayT;
    const len = PHASE_ORDER.length;

    // Encontrar índice de la fase ACTUAL (la que acaba de quedar atrás)
    let idx = 0;
    for (let i = 0; i < len; i++) {
      if (t >= PHASE_ORDER[i].t) idx = i;
    }

    const phaseA = PHASE_ORDER[idx];
    const phaseB = PHASE_ORDER[(idx + 1) % len];

    // t_next de phaseB: si B es dawn (t=0) y t>0.65 → usar t_next=1.0
    const tA = phaseA.t;
    const tB = phaseB.t < tA ? phaseB.t + 1.0 : phaseB.t;

    // Alpha local en [0, 1]
    const alpha = tB > tA ? (t - tA) / (tB - tA) : 0;

    // Interpolar colores de cielo, niebla, ambiente y sol
    this._curSky    .copy(phaseA.sky    ).lerp(phaseB.sky,     alpha);
    this._curFog    .copy(phaseA.fog    ).lerp(phaseB.fog,     alpha);
    this._curAmbient.copy(phaseA.ambient).lerp(phaseB.ambient, alpha);
    this._curSun    .copy(phaseA.sun    ).lerp(phaseB.sun,     alpha);

    // ── NUEVO: interpolar color de nubes ─────────────────────────────
    //  MeshBasicMaterial.color se MULTIPLICA por el color de la textura.
    //  La textura tiene píxeles blancos/grises, así que multiplicar por
    //  un color oscuro la vuelve oscura sin necesidad de recrear la textura.
    //
    //  Progresión:
    //    dawn     → 0xffbb88  (rosado-naranja: reflejo del amanecer)
    //    noon     → 0xffffff  (blanco puro: luz solar directa)
    //    dusk     → 0xff9966  (naranja encendido: reflejo del atardecer)
    //    midnight → 0x1e2233  (gris-azul muy oscuro: noche sin luna llena)
    this._curCloud.copy(phaseA.cloud).lerp(phaseB.cloud, alpha);
    this._cloudMesh.material.color.copy(this._curCloud);

    // Interpolar intensidades de luces
    this._ambient.intensity = phaseA.ambientIntensity +
      (phaseB.ambientIntensity - phaseA.ambientIntensity) * alpha;
    this._sun.intensity = phaseA.sunIntensity +
      (phaseB.sunIntensity - phaseA.sunIntensity) * alpha;

    // Opacidad de las nubes: fija en 0.78 — el color ya maneja la visibilidad nocturna.
    // (Antes se hackeaba con opacity variable, pero eso causaba parpadeos al cambiar fase)
    this._cloudMesh.material.opacity = 0.78;
  }

  // ─────────────────────────────────────────────────────────────
  //  ⏱️  setTime(phase) — herramienta de desarrollo
  //  ─────────────────────────────────────────────────────────────
  //  Salta el reloj interno a una de las 4 fases clave.
  //  El ciclo continúa avanzando desde ese punto.
  //
  //  @param {'dawn'|'noon'|'dusk'|'midnight'} phase
  //
  //  Fases y su dayT:
  //    dawn     → 0.00   (amanecer)
  //    noon     → 0.25   (mediodía)
  //    dusk     → 0.50   (atardecer)
  //    midnight → 0.75   (medianoche)
  // ─────────────────────────────────────────────────────────────
  setTime(phase) {
    // ── Mapa de teclas rápidas → dayT correspondiente ─────────────
    //  dawn     → 0.000  inicio de la transición de amanecer
    //  noon     → 0.075  inicio del plateau de día (azul estable)
    //  dusk     → 0.575  inicio de la transición de atardecer
    //  midnight → 0.650  inicio del plateau de noche (oscuro estable)
    const MAP = { dawn: 0.000, noon: 0.075, dusk: 0.575, midnight: 0.650 };
    if (phase in MAP) {
      this._dayT = MAP[phase];
      // Forzar una actualización inmediata del color para que el
      // cambio sea instantáneo y no espere al próximo frame.
      this._interpolatePhase();
      this._scene.background.copy(this._curSky);
      this._scene.fog.color.copy(this._curFog);
      this._ambient.color.copy(this._curAmbient);
      this._sun.color.copy(this._curSun);
      this._pivot.rotation.x = this._dayT * Math.PI * 2;
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  📡  Getter: hora del día normalizada [0, 1) para HUD u otros módulos
  // ─────────────────────────────────────────────────────────────
  get dayT() { return this._dayT; }
}