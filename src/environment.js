// ═══════════════════════════════════════════════════════════════
//  src/environment.js
//  Responsabilidades:
//    • Ciclo de día y noche (paleta de colores para cielo, niebla,
//      ambientLight y sunLight interpolados con lerp)
//    • Sol y Luna visibles: geometría con texturas procedurales,
//      pivote que rota sobre el eje X y sigue al jugador
//    • Nubes flotantes: plano con textura procedimental transparente
//      cuyo offset avanza lentamente cada frame
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

// ─── Paleta de colores para cada fase del día ──────────────────
//  sky    → scene.background / scene.fog.color
//  ambient→ color de la AmbientLight
//  sun    → color de la DirectionalLight (luz solar)
//  cloud  → color multiplicativo del MeshBasicMaterial de las nubes
//           (se multiplica por la textura blanca → produce el tinte)
//
//  TIEMPOS EXACTOS — ciclo de 20 minutos como Minecraft:
//  ┌────────────┬──────────┬───────────┬─────────────────────────┐
//  │ Fase       │ Duración │ % ciclo   │ dayT inicio             │
//  ├────────────┼──────────┼───────────┼─────────────────────────┤
//  │ Amanecer   │  1.5 min │   7.5 %   │ 0.000                   │
//  │ Día (noon) │ 10.0 min │  50.0 %   │ 0.075                   │
//  │ Atardecer  │  1.5 min │   7.5 %   │ 0.575                   │
//  │ Noche      │  7.0 min │  35.0 %   │ 0.650                   │
//  └────────────┴──────────┴───────────┴─────────────────────────┘
//  Total: 0.075 + 0.500 + 0.075 + 0.350 = 1.000 ✓
//
//  La rotación del pivote (dayT × 2π) hace que:
//    • dayT 0.000–0.075 : sol saliendo (amanecer corto de 7.5%)
//    • dayT 0.075–0.575 : sol en lo alto durante 50% → día largo ✓
//    • dayT 0.575–0.650 : sol poniéndose (atardecer corto)
//    • dayT 0.650–1.000 : luna visible durante 35% → noche larga ✓
const PHASES = {
  dawn: {
    t:       0.000,                      // ← inicio del amanecer
    sky:     new THREE.Color(0xffb347),  // naranja cálido amanecer
    fog:     new THREE.Color(0xff9966),
    ambient: new THREE.Color(0xffa070),
    sun:     new THREE.Color(0xffe0aa),
    sunIntensity:     0.45,
    ambientIntensity: 0.40,
    cloud:   new THREE.Color(0xffbb88),  // rosado-naranja: nubes al amanecer
  },
  noon: {
    t:       0.075,                      // ← amanecer dura 7.5% → noon arranca aquí
    sky:     new THREE.Color(0x87CEEB),  // azul cielo de día
    fog:     new THREE.Color(0x87CEEB),
    ambient: new THREE.Color(0xffffff),
    sun:     new THREE.Color(0xfffbe0),
    sunIntensity:     0.90,
    ambientIntensity: 0.55,
    cloud:   new THREE.Color(0xffffff),  // blanco puro al mediodía
  },
  dusk: {
    t:       0.575,                      // ← día dura 50% → dusk arranca aquí
    sky:     new THREE.Color(0xff6030),  // rojo/naranja atardecer
    fog:     new THREE.Color(0xff7755),
    ambient: new THREE.Color(0xff8844),
    sun:     new THREE.Color(0xffaa55),
    sunIntensity:     0.35,
    ambientIntensity: 0.30,
    cloud:   new THREE.Color(0xff9966),  // naranja encendido: nubes al atardecer
  },
  midnight: {
    t:       0.650,                      // ← atardecer dura 7.5% → noche arranca aquí
    sky:     new THREE.Color(0x080c18),  // azul muy oscuro noche
    fog:     new THREE.Color(0x0a0f20),
    ambient: new THREE.Color(0x1a2844),  // azul nocturno tenue
    sun:     new THREE.Color(0x4466aa),
    sunIntensity:     0.00,
    ambientIntensity: 0.12,
    cloud:   new THREE.Color(0x1e2233),  // gris-azul muy oscuro: nubes nocturnas
  },
};

// Orden garantizado para la interpolación circular
const PHASE_ORDER = [PHASES.dawn, PHASES.noon, PHASES.dusk, PHASES.midnight];

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
//  ☁️  TEXTURA PROCEDURAL DE NUBES
//  Parches cuadrados blancos sobre fondo totalmente transparente.
//  Estética vóxel: cada "nube" es un conjunto de rectángulos.
// ═══════════════════════════════════════════════════════════════
function makeCloudTexture() {
  const size   = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx    = canvas.getContext('2d');

  ctx.clearRect(0, 0, size, size);

  // Generamos 18 "copos" de nube, cada uno con 6-10 bloques cuadrados
  const rng = () => Math.random();
  const cloudCount = 18;

  for (let c = 0; c < cloudCount; c++) {
    const cx  = (rng() * size) | 0;
    const cy  = (rng() * size) | 0;
    const blocks = 6 + ((rng() * 5) | 0);
    const blockSize = 24 + ((rng() * 16) | 0);  // 24–40 px

    // Color ligeramente variable: blanco a gris muy claro
    const v = 230 + ((rng() * 25) | 0);
    ctx.fillStyle = `rgba(${v}, ${v}, ${v}, 0.88)`;

    for (let b = 0; b < blocks; b++) {
      const ox = cx + ((rng() * blockSize * 2 - blockSize) | 0);
      const oy = cy + ((rng() * blockSize     - blockSize / 2) | 0);
      const bw = blockSize + ((rng() * 16) | 0);
      const bh = (blockSize * 0.55) | 0;
      ctx.fillRect(ox, oy, bw, bh);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(4, 4);            // teselar 4x para mayor densidad
  tex.magFilter = THREE.LinearFilter;
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
    this._cloudTex = makeCloudTexture();

    const cloudGeo = new THREE.PlaneGeometry(220, 220);
    const cloudMat = new THREE.MeshBasicMaterial({
      map:         this._cloudTex,
      transparent: true,
      opacity:     0.78,
      fog:         false,
      depthWrite:  false,
      side:        THREE.DoubleSide,
    });
    this._cloudMesh = new THREE.Mesh(cloudGeo, cloudMat);
    this._cloudMesh.rotation.x = -Math.PI / 2;  // plano horizontal
    this._cloudMesh.position.y = 42;             // altura de las nubes
    scene.add(this._cloudMesh);
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

    // 7. Mover offset de nubes lentamente para simular viento
    //    0.00008 por segundo → 1 ciclo completo en ~3.5 minutos reales
    this._cloudTex.offset.x += 0.000080 * dt * 60;  // independiente de fps
    this._cloudTex.offset.needsUpdate = true;

    // 8. Las nubes siguen al jugador en XZ para no desaparecer al alejarse
    this._cloudMesh.position.x = camPos.x;
    this._cloudMesh.position.z = camPos.z;
  }

  // ─────────────────────────────────────────────────────────────
  //  🌈  INTERPOLACIÓN DE FASES — corazón del ciclo día/noche
  //  ─────────────────────────────────────────────────────────────
  //  ALGORITMO:
  //  1. Buscamos entre qué dos fases consecutivas cae dayT.
  //  2. Calculamos un alpha local [0,1] entre esas dos fases.
  //  3. Interpolamos linealmente (lerp) cada componente de color
  //     e intensidad.
  //
  //  El ciclo es CIRCULAR: la última fase (midnight, t=0.75) debe
  //  interpolar de vuelta a la primera (dawn, t=0.00/1.00).
  //  Solución: al comparar contra midnight usamos t_next = 1.0
  //  para que el tramo [0.75, 1.00] funcione correctamente.
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
    // ── Mapa actualizado con los tiempos asimétricos ──────────────
    //  Valores coinciden exactamente con los .t de PHASES:
    //    dawn     → 0.000  (inicio del amanecer de 7.5%)
    //    noon     → 0.075  (inicio del día de 50%)
    //    dusk     → 0.575  (inicio del atardecer de 7.5%)
    //    midnight → 0.650  (inicio de la noche de 35%)
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