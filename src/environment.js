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
    // ── Nubes 3D — InstancedMesh con cuadrícula estricta ─────────
    //
    //  PROBLEMA ANTERIOR: posiciones aleatorias + rotación Y aleatoria
    //  causaban solapamientos visuales frecuentes.
    //
    //  SOLUCIÓN — Sistema de cuadrícula (grid):
    //
    //  El área 200×200 se divide en celdas de CELL_SIZE×CELL_SIZE.
    //  Con CELL_SIZE=20 obtenemos una cuadrícula de 10×10 = 100 celdas.
    //  Cada celda puede generar UNA SOLA nube con probabilidad SPAWN_PROB,
    //  centrada exactamente en el centro de la celda.
    //
    //  Garantía de no-solapamiento:
    //    MAX_SX = MAX_SZ = 16  <  CELL_SIZE = 20
    //  La nube más grande siempre tiene 2 unidades de margen libre
    //  en cada eje respecto al borde de su celda → nunca invade
    //  la celda vecina.
    //
    //  Rotación Y = 0 para todas: los bloques quedan alineados con
    //  los ejes del mundo, coherente con la estética vóxel.
    //
    //  Wrap-around y rendimiento: igual que la versión anterior.
    //  CLOUD_SPREAD = 100 (radio del área = 200/2).
    //  Máximo 100 instancias × 12 tri = 1200 tri en 1 draw call.

    const CELL_SIZE  = 20;
    const GRID_COLS  = 10;          // 200 / CELL_SIZE
    const GRID_ROWS  = 10;
    const SPAWN_PROB = 0.30;        // probabilidad de nube por celda
    const CLOUD_Y    = 42;
    const MAX_SX     = 16;          // siempre < CELL_SIZE → sin solapamiento
    const MAX_SZ     = 16;

    // ── Primer paso: construir el listado de nubes ────────────────
    //  No podemos saber el recuento exacto antes de tirar los dados,
    //  así que recogemos primero, construimos el InstancedMesh después.
    const clouds = [];
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        if (Math.random() > SPAWN_PROB) continue;

        // Centro de la celda (origen del grid en -100,-100 para
        // que el área cubierta sea simétrica respecto al mundo).
        const cx = -100 + col * CELL_SIZE + CELL_SIZE * 0.5;
        const cz = -100 + row * CELL_SIZE + CELL_SIZE * 0.5;

        clouds.push({
          x:  cx,
          y:  CLOUD_Y,
          z:  cz,
          sx: 4 + Math.random() * (MAX_SX - 4),   // ancho  4–16 u
          sy: 1.5 + Math.random() * 1.5,           // alto   1.5–3 u
          sz: 4 + Math.random() * (MAX_SZ - 4),   // prof   4–16 u
          // rotation.y = 0 implícito — sin rotación aleatoria
        });
      }
    }

    // ── Segundo paso: crear InstancedMesh con el recuento real ────
    const count    = Math.max(1, clouds.length);  // mínimo 1 evita error WebGL
    const cloudGeo = new THREE.BoxGeometry(1, 1, 1);
    const cloudMat = new THREE.MeshBasicMaterial({
      color:       0xffffff,   // blanco base; _interpolatePhase() lo tinta
      transparent: true,
      opacity:     0.82,
      fog:         false,      // siempre visibles, sin desvanecerse con la niebla
      depthWrite:  false,      // sin z-fighting entre nubes adyacentes
      side:        THREE.FrontSide,
    });

    this._cloudMesh       = new THREE.InstancedMesh(cloudGeo, cloudMat, count);
    this._cloudMesh.count = clouds.length;   // Three.js r158: count es settable
    // frustumCulled = false: el bounding box del InstancedMesh coincide con
    // la BoxGeometry base (1×1×1), ignorando la escala de las instancias.
    // Three.js descartaría erróneamente nubes escaladas a 16×3×16.
    this._cloudMesh.frustumCulled = false;
    scene.add(this._cloudMesh);

    this._cloudData   = clouds;
    this._cloudSpread = (GRID_COLS * CELL_SIZE) / 2;  // = 100
    this._cloudDummy  = new THREE.Object3D();

    // Inicializar matrices (rotation = 0 por defecto en Object3D)
    const dummy = this._cloudDummy;
    dummy.rotation.set(0, 0, 0);   // garantía explícita: sin rotación Y
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i];
      dummy.position.set(c.x, c.y, c.z);
      dummy.scale.set(c.sx, c.sy, c.sz);
      dummy.updateMatrix();
      this._cloudMesh.setMatrixAt(i, dummy.matrix);
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

    // 4. Rotar pivote usando el mapa asimétrico de ángulos.
    //    _dayTToSunAngle() garantiza que el sol esté exactamente
    //    en el horizonte al centro de dawn y dusk, y en el cénit
    //    al centro de noon; la luna replica el mismo contrato.
    this._pivot.rotation.x = this._dayTToSunAngle(this._dayT);

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
    //    WIND = 0.264 u/s — misma velocidad que la antigua textura 2D.
    //    CLOUD_SPREAD = 100 (área de 200×200 / 2).
    //    Wrap en X: avance del viento con teletransporte al lado opuesto.
    //    Wrap en Z: seguimiento lateral del jugador sin viento.
    //    rotation.y = 0 siempre → ya fijado en dummy antes del bucle.
    {
      const WIND  = 0.264;
      const camX  = camPos.x;
      const camZ  = camPos.z;
      const wrap  = this._cloudSpread;    // 100
      const dummy = this._cloudDummy;

      // La rotación del dummy es 0 desde la construcción y nunca cambia.
      // Fijarla fuera del bucle evita asignarla N veces por frame.
      dummy.rotation.set(0, 0, 0);

      for (let i = 0; i < this._cloudData.length; i++) {
        const c = this._cloudData[i];

        c.x += WIND * dt;

        if (c.x - camX >  wrap) c.x -= wrap * 2;
        if (c.x - camX < -wrap) c.x += wrap * 2;
        if (c.z - camZ >  wrap) c.z -= wrap * 2;
        if (c.z - camZ < -wrap) c.z += wrap * 2;

        dummy.position.set(c.x, c.y, c.z);
        dummy.scale.set(c.sx, c.sy, c.sz);
        dummy.updateMatrix();
        this._cloudMesh.setMatrixAt(i, dummy.matrix);
      }
      this._cloudMesh.instanceMatrix.needsUpdate = true;
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  ☀️  _dayTToSunAngle(t) — mapeo asimétrico dayT → ángulo pivote
  //  ─────────────────────────────────────────────────────────────
  //  PROBLEMA ANTERIOR: `pivot.rotation.x = dayT × 2π` es una función
  //  lineal que reparte los 360° de la órbita proporcionalmente al
  //  tiempo, ignorando que las fases son asimétricas (día=50%,
  //  noche=35%). Resultado: cuando empieza "dusk" (t=0.575), el sol
  //  ya está a 0.575×360° = 207° → ¡bajo tierra! El sol debería
  //  estar aún cerca del horizonte.
  //
  //  SOLUCIÓN — interpolación lineal por tramos con 4 anclas:
  //
  //  Cada ancla vincula un instante concreto del reloj (centro de
  //  su fase) a un ángulo físico exacto del pivote:
  //
  //    t_dawn   = 0.0375  →  angle = 0        (sol en horizonte, saliendo)
  //    t_noon   = 0.325   →  angle = π/2      (sol en el cénit)
  //    t_dusk   = 0.6125  →  angle = π        (sol en horizonte, poniéndose)
  //    t_night  = 0.7875  →  angle = 3π/2     (luna en el cénit)
  //    t_dawn+1 = 1.0375  →  angle = 2π       (cierra el ciclo)
  //
  //  Verificación geométrica (sol en local Z=-110, pivote rota en X):
  //    world_Y_sol  = 110 × sin(angle)   → 0 en horizonte, +110 en cénit ✓
  //    world_Y_luna = –110 × sin(angle)  → +110 cuando angle=3π/2 ✓
  //
  //  Para t < t_dawn (= 0.0375) se suma 1.0 al tiempo antes de buscar
  //  el segmento, haciendo que caiga en el último tramo [0.7875, 1.0375).
  //  Esto produce un ángulo justo por debajo de 2π — el sol aún no ha
  //  salido en el primer instante del ciclo.
  // ─────────────────────────────────────────────────────────────
  _dayTToSunAngle(t) {
    const PI = Math.PI;

    // Anclas (dayT, ángulo) — ordenadas ascendentemente por dayT
    const K = [
      [0.0375, 0       ],   // dawn center  — sol en horizonte E
      [0.325,  PI / 2  ],   // noon center  — sol en cénit
      [0.6125, PI      ],   // dusk center  — sol en horizonte O
      [0.7875, PI * 1.5],   // midnight ctr — luna en cénit
      [1.0375, PI * 2  ],   // dawn+1 cycle — cierra el ciclo
    ];

    // Para t antes de la primera ancla, desplazamos al último tramo
    const tN = t < K[0][0] ? t + 1.0 : t;

    for (let i = 0; i < K.length - 1; i++) {
      const [t0, a0] = K[i];
      const [t1, a1] = K[i + 1];
      if (tN >= t0 && tN < t1) {
        return a0 + (tN - t0) / (t1 - t0) * (a1 - a0);
      }
    }
    return 0;  // fallback (no debe alcanzarse)
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
      this._pivot.rotation.x = this._dayTToSunAngle(this._dayT);
    }
  }

  // ─────────────────────────────────────────────────────────────
  //  📡  Getter: hora del día normalizada [0, 1) para HUD u otros módulos
  // ─────────────────────────────────────────────────────────────
  get dayT() { return this._dayT; }
}