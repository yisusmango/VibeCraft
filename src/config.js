// ═══════════════════════════════════════════════════════════════
//  src/config.js
//  Configuración centralizada del juego VibeCraft.
// ═══════════════════════════════════════════════════════════════

export const CONFIG = Object.freeze({
  // ── Movimiento del jugador ──────────────────────────────────
  MOVE_SPEED   : 5.0,
  JUMP_FORCE   : 8.0,
  GRAVITY      : -20.0,

  // ── Cuerpo del jugador ──────────────────────────────────────
  PLAYER_HEIGHT: 1.8,
  PLAYER_WIDTH : 0.6,
  EYE_HEIGHT   : 1.6,

  // ── Sistema de Chunks ────────────────────────────────────────
  //  CHUNK_SIZE      : lado en bloques de un chunk (X y Z).
  //  RENDER_DISTANCE : radio en chunks alrededor del jugador.
  //                    2 → área visible de 5×5 chunks = 80×80 bloques.
  CHUNK_SIZE     : 16,
  RENDER_DISTANCE: 2,

  // ── Compatibilidad con player.js ─────────────────────────────
  //  WORLD_SIZE ya NO controla la generación de terreno.
  //  Se retiene ÚNICAMENTE para la barrera de seguridad en player.js
  //  (respawn si el jugador cae a Y < −20).
  //  Valor = CHUNK_SIZE × (RENDER_DISTANCE×2 + 1) = 16 × 5 = 80
  //  → el centro de respawn queda en (40, 32, 40).
  WORLD_SIZE   : 80,

  // ── Interacción ─────────────────────────────────────────────
  MAX_REACH    : 5.0,
});

/**
 * HALF_W — Semiancho del jugador.
 * Exportado por separado porque lo usan player.js e interaction.js.
 */
export const HALF_W = CONFIG.PLAYER_WIDTH / 2;  // = 0.3