// ═══════════════════════════════════════════════════════════════
//  src/audio.js  —  VibeCraft · Sistema de Audio Espacial
//  ─────────────────────────────────────────────────────────────
//  Responsabilidades EXCLUSIVAS de este archivo:
//    1. Instanciar y configurar THREE.AudioListener sobre la cámara
//    2. Cargar todos los assets de sonido con THREE.AudioLoader
//    3. Exponer funciones de reproducción para pasos, rotura y colocación
//
//  TÉCNICA ANTI-MACHINE-GUN:
//    Antes de cada play(), paramos el sonido si ya estaba sonando
//    (stop → play) y aleatorizamos el pitch con setDetune() en un
//    rango de ±150 cents (300 en total).
//    Resultado: cada reproducción suena ligeramente diferente,
//    eliminando el efecto metálico y repetitivo al caminar.
//
//  MAPEO DE TIPOS:
//    'stone' | 'glass' → step_stone  (para pasos)
//    cualquier otro    → step_grass  (para pasos)
//    break / place     → _grass      (únicos assets disponibles)
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';

// ── Instancias de módulo (singleton) ────────────────────────────
/** @type {THREE.AudioListener|null} */
let listener = null;

/**
 * Diccionario de instancias THREE.Audio indexadas por nombre de asset.
 * Se rellena de forma asíncrona conforme AudioLoader completa cada carga.
 * Las funciones de reproducción comprueban que el buffer esté cargado
 * antes de invocar play() para evitar errores en los primeros frames.
 *
 * @type {Record<string, THREE.Audio>}
 */
const sounds = {};

// ═══════════════════════════════════════════════════════════════
//  🔊  FUNCIÓN INTERNA DE REPRODUCCIÓN
//  ─────────────────────────────────────────────────────────────
//  ORDEN DE OPERACIONES (crítico para Three.js r158):
//
//  Three.js no instancia el AudioBufferSourceNode interno
//  (sound.source) hasta que se invoca play(). Por tanto, llamar
//  a setDetune() antes de play() provoca:
//    "Cannot read properties of null (reading 'detune')"
//
//  Orden correcto:
//    1. stop()      — si ya estaba sonando, libera el source anterior
//    2. play()      — Three.js crea el nuevo AudioBufferSourceNode
//    3. setDetune() — ahora sound.source existe y .detune es válido
//
//  La guardia `sound.source && sound.source.detune` protege frente
//  a posibles implementaciones futuras donde source pueda ser null
//  en casos extremos (e.g. contexto suspendido durante play()).
// ═══════════════════════════════════════════════════════════════

/**
 * Reproduce un sonido con variación de pitch aleatoria.
 * Si el sonido ya estaba reproduciéndose se detiene primero.
 *
 * @param {THREE.Audio|undefined} sound
 */
function _play(sound) {
  // Guardia de seguridad: buffer no cargado todavía o clave inválida
  if (!sound || !sound.buffer) return;

  // Anti-machine-gun paso 1: cortar reproducción en curso
  if (sound.isPlaying) sound.stop();

  // 1. Primero play() para que Three.js instancie el source node interno
  sound.play();

  // 2. Anti-machine-gun paso 2: variar el pitch ±150 cents
  // Ahora es seguro llamarlo porque sound.source ya no es null
  if (sound.source && sound.source.detune) {
    sound.setDetune((Math.random() - 0.5) * 300);
  }
}

// ═══════════════════════════════════════════════════════════════
//  🎛️  CARGA DE ASSETS
//  ─────────────────────────────────────────────────────────────
//  Cada asset se carga como buffer independiente.
//  Al resolver el callback, creamos una instancia THREE.Audio
//  con el listener activo y la almacenamos en `sounds`.
//
//  Nota de arquitectura: usamos un único AudioLoader (reusable)
//  para las 5 cargas; AudioLoader no tiene estado interno que
//  impida reutilizarlo en paralelo.
// ═══════════════════════════════════════════════════════════════

/**
 * Carga un archivo de sonido y registra la instancia en `sounds`.
 *
 * @param {string} key    — Clave en el diccionario `sounds`
 * @param {string} file   — Nombre de archivo (relativo a ./assets/sounds/)
 * @param {number} volume — Volumen base [0, 1]
 */
function _loadSound(key, file, volume = 0.6) {
  const loader = new THREE.AudioLoader();
  loader.load(
    `./assets/sounds/${file}`,
    (buffer) => {
      const audio = new THREE.Audio(listener);
      audio.setBuffer(buffer);
      audio.setVolume(volume);
      sounds[key] = audio;
    },
    undefined,  // onProgress — no necesitamos barra de carga para audio
    (err) => {
      // Error no fatal: el juego funciona sin sonido si el asset falta
      console.warn(`[Audio] No se pudo cargar "${file}":`, err);
    }
  );
}

// ═══════════════════════════════════════════════════════════════
//  🚀  INICIALIZACIÓN PÚBLICA
// ═══════════════════════════════════════════════════════════════

/**
 * Inicializa el sistema de audio.
 * DEBE llamarse después de crear la cámara y antes del bucle de animación.
 * Requiere un gesto de usuario previo (WebAudio API) — el PointerLock
 * que el jugador activa al iniciar la partida sirve como dicho gesto.
 *
 * @param {THREE.Camera} camera — La cámara principal de la escena
 */
export function initAudio(camera) {
  // AudioListener es el "oído" en el mundo 3D; al añadirlo a la cámara
  // su posición y orientación se actualizan automáticamente cada frame.
  listener = new THREE.AudioListener();
  camera.add(listener);

  // ── Cargar los 5 assets de sonido ────────────────────────────
  //  Volúmenes ajustados para que los pasos no enmascaren el ambiente.
  _loadSound('step_grass',  'step_grass.ogg',  0.55);
  _loadSound('step_stone',  'step_stone.ogg',  0.55);
  _loadSound('pop',         'pop.ogg',         0.70);
  _loadSound('break_grass', 'break_grass.ogg', 0.75);
  _loadSound('place_grass', 'place_grass.ogg', 0.75);

  console.info('[Audio] Sistema de audio inicializado.');
}

// ═══════════════════════════════════════════════════════════════
//  🦶  PASOS — playStepSound
//  ─────────────────────────────────────────────────────────────
//  Mapeo de tipo de bloque a sonido de paso:
//    stone | glass → step_stone  (superficie dura, eco corto)
//    cualquier otro → step_grass  (superficie blanda)
//
//  `type` puede ser null (posición en el aire) → no reproducir nada.
// ═══════════════════════════════════════════════════════════════

/**
 * Reproduce el sonido de paso adecuado según la superficie.
 * @param {string|null} type — Tipo del bloque bajo el jugador
 */
export function playStepSound(type) {
  if (!type) return;  // jugador en el aire, sin bloque debajo

  const isHardSurface = type === 'stone' || type === 'glass';
  _play(isHardSurface ? sounds['step_stone'] : sounds['step_grass']);
}

// ═══════════════════════════════════════════════════════════════
//  🎵  POP — playPopSound
//  ─────────────────────────────────────────────────────────────
//  Sonido genérico de UI / selección. Sin mapeo de tipo.
// ═══════════════════════════════════════════════════════════════

/**
 * Reproduce el sonido de "pop" (UI / pickup / interacción genérica).
 */
export function playPopSound() {
  _play(sounds['pop']);
}

// ═══════════════════════════════════════════════════════════════
//  ⛏️  ROMPER BLOQUE — playBreakSound
//  ─────────────────────────────────────────────────────────────
//  Solo disponemos de break_grass.ogg.
//  Se aplica a todos los tipos; en el futuro se puede extender
//  añadiendo 'break_stone' al diccionario y actualizando el mapeo.
// ═══════════════════════════════════════════════════════════════

/**
 * Reproduce el sonido de rotura de bloque.
 * @param {string|null} type — Tipo del bloque roto (reservado para extensiones futuras)
 */
export function playBreakSound(type) {
  // Actualmente usamos break_grass como sonido universal de rotura.
  // El parámetro `type` está disponible para mapeo futuro (break_stone, etc.)
  void type;
  _play(sounds['break_grass']);
}

// ═══════════════════════════════════════════════════════════════
//  🧱  COLOCAR BLOQUE — playPlaceSound
//  ─────────────────────────────────────────────────────────────
//  Solo disponemos de place_grass.ogg.
//  Misma filosofía de extensibilidad que playBreakSound.
// ═══════════════════════════════════════════════════════════════

/**
 * Reproduce el sonido de colocación de bloque.
 * @param {string|null} type — Tipo del bloque colocado (reservado para extensiones futuras)
 */
export function playPlaceSound(type) {
  // Actualmente usamos place_grass como sonido universal de colocación.
  void type;
  _play(sounds['place_grass']);
}

// ═══════════════════════════════════════════════════════════════
//  ▶️  REANUDAR CONTEXTO — resumeAudio
//  ─────────────────────────────────────────────────────────────
//  La Política de Autoplay de los navegadores modernos fuerza al
//  AudioContext a arrancar en estado "suspended" hasta que el
//  usuario realice un gesto explícito (clic, teclado, etc.).
//
//  Three.js crea el AudioContext internamente al instanciar
//  AudioListener, pero no lo reanuda automáticamente.
//
//  CUÁNDO LLAMAR:
//    Invocar desde launchWorld() en main.js, justo antes de
//    controls.lock(). En ese punto el jugador acaba de hacer clic
//    en un botón → el navegador lo acepta como gesto válido y
//    permite que resume() resuelva su Promise correctamente.
//
//  IDEMPOTENCIA:
//    La guardia `state === 'suspended'` hace la función segura
//    para llamarse múltiples veces (p.ej. al volver del menú de
//    pausa): si el contexto ya está "running", no hace nada.
// ═══════════════════════════════════════════════════════════════

/**
 * Reanuda el AudioContext si está suspendido por la Política de Autoplay.
 * Llamar siempre desde dentro de un handler de gesto de usuario.
 */
export function resumeAudio() {
  if (listener && listener.context && listener.context.state === 'suspended') {
    listener.context.resume();
    console.info('[Audio] AudioContext reanudado con éxito.');
  }
}