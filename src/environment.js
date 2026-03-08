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
    this._curCloud   = new THREE.Color();  // tinte interpolado de las nubes

    // ── Estado de las nubes (async) ────────────────────────────────
    //  _cloudMesh es null hasta que clouds.png termina de cargar.
    //  Todos los sistemas que lo usen deben hacer guard: if (!this._cloudMesh) return.
    //  _cloudWindX acumula el desplazamiento de viento (unidades mundo, eje X).
    this._cloudMesh  = null;
    this._cloudWindX = 0;

    this._buildCelestials(scene);
    this._buildClouds(scene);   // non-blocking: la malla se añade a la escena al cargar
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
    // ── Nubes 3D basadas en mapa de bits — InstancedMesh ─────────
    //
    //  DISEÑO (al estilo Minecraft original):
    //
    //  1. Cargamos `clouds.png` (256×256, blanco=nube, negro=vacío).
    //  2. La leemos con getImageData() y muestreamos cada 2px →
    //     cuadrícula de 128×128 = hasta 16.384 candidatos.
    //  3. Solo los píxeles con canal R > 127 generan un vóxel de nube.
    //  4. Creamos UN SOLO InstancedMesh con exactamente N instancias
    //     (N = recuento exacto de píxeles blancos), sin índices vacíos.
    //  5. Todas las instancias tienen escala uniforme (VOXEL_SIZE, VOXEL_H, VOXEL_SIZE)
    //     y se posicionan en una cuadrícula centrada en (0,0) al nivel CLOUD_Y.
    //     Las matrices se calculan UNA SOLA VEZ y nunca se actualizan.
    //
    //  MOVIMIENTO DE VIENTO (update):
    //    En lugar de mover N matrices individuales por frame, movemos el
    //    Object3D raíz del InstancedMesh:
    //      mesh.position.x = camPos.x + (windOffset % MAP_WORLD_SIZE)
    //      mesh.position.z = camPos.z
    //    Cuando windOffset cicla MAP_WORLD_SIZE unidades, el mesh salta
    //    exactamente un mapa completo → sin discontinuidad visible porque
    //    el patrón de nubes es periódico (tileado implícito).
    //
    //  TAMAÑOS:
    //    STRIDE      = 2   → muestreo cada 2 px → 128×128 = 16 384 muestras máx
    //    VOXEL_SIZE  = 16  → cada píxel = cubo de 16×8×16 unidades mundo
    //    MAP_WORLD_SIZE = 128 × 16 = 2 048 unidades (capa de nubes 2 km "ancha")
    //
    //  RENDIMIENTO:
    //    ~4 000–8 000 instancias típicas (según PNG) × 12 tri = ≤ 96 k tri
    //    en 1 sola draw call — 0 actualizaciones de matriz por frame.

    const STRIDE      = 2;
    const VOXEL_SIZE  = 16;
    const VOXEL_H     = 8;
    const CLOUD_Y     = 60;
    const IMG_SIZE    = 256;
    const SAMPLES     = IMG_SIZE / STRIDE;            // 128
    const MAP_WORLD_SIZE = SAMPLES * VOXEL_SIZE;      // 2048 unidades

    // Material compartido — igual que antes; _interpolatePhase() solo
    // necesita acceder a cloudMat.color, lo haremos vía this._cloudMesh.material.
    const cloudMat = new THREE.MeshBasicMaterial({
      color:      0xffffff,
      transparent: true,
      opacity:    0.82,
      // fog: true — los voxels de nube reaccionan a scene.fog.
      // Esto hace que los bordes del InstancedMesh (≈1024 u del jugador)
      // queden 100 % cubiertos por la niebla, ocultando la geometría finita
      // del grid exactamente como lo hace Minecraft con su capa de nubes.
      // MeshBasicMaterial soporta niebla nativamente via su shader GLSL.
      fog:        true,
      depthWrite: false,
      side:       THREE.FrontSide,
    });

    // ── Carga asíncrona ───────────────────────────────────────────
    //  Usamos Image nativo en lugar de THREE.ImageLoader para acceder
    //  a getImageData() directamente sin pasar por una textura GPU.
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      // ── Leer píxeles ────────────────────────────────────────────
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = IMG_SIZE;
      const ctx    = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(0, 0, IMG_SIZE, IMG_SIZE);
      //  data: Uint8ClampedArray de largo IMG_SIZE × IMG_SIZE × 4 (RGBA)
      //  Índice del canal R del píxel (col, row):
      //    i = (row * IMG_SIZE + col) * 4

      // ── Primer paso: recoger posiciones de todos los píxeles blancos ──
      const positions = [];
      for (let row = 0; row < IMG_SIZE; row += STRIDE) {
        for (let col = 0; col < IMG_SIZE; col += STRIDE) {
          const r = data[(row * IMG_SIZE + col) * 4];  // canal R (0-255)
          if (r > 127) {
            // Centrar la cuadrícula en (0,0): colIdx en [0, SAMPLES),
            // restamos SAMPLES/2 para que el rango sea [-SAMPLES/2, +SAMPLES/2).
            const colIdx = col / STRIDE;
            const rowIdx = row / STRIDE;
            positions.push({
              x: (colIdx - SAMPLES / 2) * VOXEL_SIZE,
              z: (rowIdx - SAMPLES / 2) * VOXEL_SIZE,
            });
          }
        }
      }

      if (positions.length === 0) {
        console.warn('[VibeCraft] clouds.png no produjo ningún vóxel blanco.');
        return;
      }

      // ── Segundo paso: crear InstancedMesh con recuento exacto ────
      //  BoxGeometry(1,1,1) base; la escala por instancia da el tamaño real.
      const cloudGeo  = new THREE.BoxGeometry(1, 1, 1);
      const cloudMesh = new THREE.InstancedMesh(cloudGeo, cloudMat, positions.length);
      // frustumCulled = false: Three.js usa el bounding box de la geometría
      // base (1×1×1) para culling, ignorando la escala de las instancias.
      // Con VOXEL_SIZE=16, cada nube escalaría a 16×8×16 → sería descartada
      // erróneamente. Desactivarlo es seguro: la GPU maneja los ≤96 k tri sin problema.
      cloudMesh.frustumCulled = false;
      // Segunda línea de defensa: Three.js puede recalcular el bounding sphere
      // al mover mesh.position cada frame en update(), lo que reintroduce el
      // test de frustum con el sphere pequeño de la geometría base (radio ≈ 0.87).
      // Asignar un sphere infinito garantiza que el test SIEMPRE pase, sin coste
      // de CPU ya que Three.js no intenta recomputarlo cuando está pre-asignado.
      cloudMesh.geometry.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(0, 0, 0),
        Infinity
      );

      // ── Tercer paso: calcular matrices (solo una vez, nunca más) ─
      //  Las posiciones X/Z están en coordenadas locales del mesh.
      //  La posición del mesh en world space la maneja update() cada frame.
      const dummy = new THREE.Object3D();
      dummy.rotation.set(0, 0, 0);   // sin rotación — estética vóxel alineada al eje
      dummy.scale.set(VOXEL_SIZE, VOXEL_H, VOXEL_SIZE);

      for (let i = 0; i < positions.length; i++) {
        dummy.position.set(positions[i].x, 0, positions[i].z);
        dummy.updateMatrix();
        cloudMesh.setMatrixAt(i, dummy.matrix);
      }
      cloudMesh.instanceMatrix.needsUpdate = true;

      // ── Cuarto paso: añadir a la escena ─────────────────────────
      //  Posición inicial Y fija; X y Z se actualizan en update().
      cloudMesh.position.y = CLOUD_Y;
      scene.add(cloudMesh);

      // Exponer al resto de la instancia
      this._cloudMesh       = cloudMesh;
      this._cloudMapSize    = MAP_WORLD_SIZE;   // 2048 u — tamaño del ciclo de wrap
      this._cloudY          = CLOUD_Y;

      // Aplicar color actual de cielo por si ya llevamos un rato en marcha
      cloudMesh.material.color.copy(this._curCloud);

      console.info(`[VibeCraft] Nubes cargadas: ${positions.length} vóxeles desde clouds.png`);
    };

    img.onerror = () => {
      console.warn('[VibeCraft] No se pudo cargar clouds.png — las nubes no se mostrarán.');
    };

    // La ruta es relativa al documento HTML (raíz del proyecto)
    img.src = './clouds.png';
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

    // 7. Mover capa de nubes con viento — wrap-around del mapa completo
    //
    //  NUEVA ESTRATEGIA (0 actualizaciones de matriz/frame):
    //  Las matrices de todas las instancias se calcularon UNA SOLA VEZ en
    //  _buildClouds() y jamás se tocan. En su lugar, movemos el mesh.position
    //  del InstancedMesh completo cada frame:
    //
    //    windX  = acumulador de viento (crece indefinidamente)
    //    wrapped = windX mod MAP_WORLD_SIZE  → [0, 2048)
    //    mesh.position.x = camPos.x + wrapped
    //    mesh.position.z = camPos.z
    //
    //  Al ciclar MAP_WORLD_SIZE unidades, el mesh salta exactamente 1 mapa
    //  de ancho. Como el patrón de nubes es periódico (viene de un PNG que
    //  tilea), el salto no produce ninguna discontinuidad visual. ✓
    //
    //  Velocidad: 0.264 u/s (idéntica a las versiones anteriores).
    if (this._cloudMesh) {
      this._cloudWindX += 0.264 * dt;
      const wrapped = ((this._cloudWindX % this._cloudMapSize) + this._cloudMapSize)
                      % this._cloudMapSize;
      this._cloudMesh.position.x = camPos.x + wrapped;
      this._cloudMesh.position.z = camPos.z;
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
    // null-guard: cloudMesh puede ser null mientras clouds.png no haya cargado
    if (this._cloudMesh) {
      this._cloudMesh.material.color.copy(this._curCloud);
      this._cloudMesh.material.opacity = 0.82;
    }

    // Interpolar intensidades de luces
    this._ambient.intensity = phaseA.ambientIntensity +
      (phaseB.ambientIntensity - phaseA.ambientIntensity) * alpha;
    this._sun.intensity = phaseA.sunIntensity +
      (phaseB.sunIntensity - phaseA.sunIntensity) * alpha;
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