// ═══════════════════════════════════════════════════════════════
//  src/config.js
//  Configuración centralizada del juego VibeCraft.
//  Todos los módulos importan desde aquí; nunca hardcodear
//  "magic numbers" en ningún otro archivo.
// ═══════════════════════════════════════════════════════════════

/**
 * CONFIG — Objeto principal de tunables del juego.
 *
 * ┌──────────────────┬──────────────────────────────────────────────┐
 * │ Variable         │ Efecto al modificar                          │
 * ├──────────────────┼──────────────────────────────────────────────┤
 * │ MOVE_SPEED       │ Velocidad horizontal (bloques/seg).          │
 * │                  │  ↑ valor → más rápido. Prueba 8–10 para sprint│
 * ├──────────────────┼──────────────────────────────────────────────┤
 * │ JUMP_FORCE       │ Velocidad vertical inicial del salto.        │
 * │                  │  ↑ valor → más alto. Prueba 12–15 para salto  │
 * │                  │  extra alto.                                 │
 * ├──────────────────┼──────────────────────────────────────────────┤
 * │ GRAVITY          │ Aceleración gravitacional (negativo = hacia  │
 * │                  │  abajo). ↓ valor (más negativo) → caída más  │
 * │                  │  rápida. Prueba −9.8 para gravedad lunar.    │
 * ├──────────────────┼──────────────────────────────────────────────┤
 * │ PLAYER_HEIGHT    │ Altura total del AABB del jugador.           │
 * ├──────────────────┼──────────────────────────────────────────────┤
 * │ PLAYER_WIDTH     │ Anchura del AABB (radio = PLAYER_WIDTH / 2). │
 * ├──────────────────┼──────────────────────────────────────────────┤
 * │ EYE_HEIGHT       │ Altura de los ojos sobre los pies.           │
 * ├──────────────────┼──────────────────────────────────────────────┤
 * │ WORLD_SIZE       │ Tamaño del terreno plano (N × N bloques).    │
 * ├──────────────────┼──────────────────────────────────────────────┤
 * │ MAX_REACH        │ Alcance del Raycaster en bloques.            │
 * └──────────────────┴──────────────────────────────────────────────┘
 */
export const CONFIG = Object.freeze({
    // ── Movimiento del jugador ──────────────────────────────────
    MOVE_SPEED   : 5.0,    // bloques/seg — velocidad horizontal
    JUMP_FORCE   : 8.0,    // bloques/seg — impulso inicial de salto
    GRAVITY      : -20.0,  // bloques/seg² — aceleración de caída
  
    // ── Cuerpo del jugador ──────────────────────────────────────
    PLAYER_HEIGHT: 1.8,    // alto total de la caja AABB
    PLAYER_WIDTH : 0.6,    // ancho de la caja AABB (radio = 0.3)
    EYE_HEIGHT   : 1.6,    // altura de los ojos sobre los pies
  
    // ── Mundo ───────────────────────────────────────────────────
    WORLD_SIZE   : 32,     // terreno de WORLD_SIZE × WORLD_SIZE bloques
  
    // ── Interacción ─────────────────────────────────────────────
    MAX_REACH    : 5.0,    // alcance máximo del Raycaster (bloques)
  });
  
  /**
   * HALF_W — Semiancho del jugador.
   * Se exporta por separado porque lo usan tanto player.js como interaction.js,
   * y calcularlo una sola vez aquí evita duplicación.
   */
  export const HALF_W = CONFIG.PLAYER_WIDTH / 2;  // = 0.3