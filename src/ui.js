// ═══════════════════════════════════════════════════════════════
//  src/ui.js
//  Responsabilidades:
//    • Gestión del overlay de inicio / pausa
//    • Actualización del HUD (coordenadas, contador de bloques)
//    • Actualización del panel de bloque apuntado
//    • Actualización del panel de estado (velocidad Y, suelo)
//
//  Este módulo no toca la escena Three.js; solo manipula el DOM.
//  Recibe datos del jugador y del estado de interacción a través
//  de los parámetros de updateHUD (no importa los módulos
//  directamente para evitar acoplamientos circulares).
// ═══════════════════════════════════════════════════════════════

// ── Referencias DOM (guardadas en variables para evitar
//    llamadas a getElementById en cada frame a 60 fps) ─────────
const elHX  = document.getElementById('hx');   // coordenada X
const elHY  = document.getElementById('hy');   // coordenada Y
const elHZ  = document.getElementById('hz');   // coordenada Z
const elHB  = document.getElementById('hb');   // contador de bloques
const elBI  = document.getElementById('bi');   // bloque apuntado
const elVY  = document.getElementById('svy');  // velocidad Y
const elSG  = document.getElementById('sg');   // estado de suelo

const overlayEl = document.getElementById('overlay');

// ═══════════════════════════════════════════════════════════════
//  🚀  INICIALIZACIÓN
// ═══════════════════════════════════════════════════════════════

/**
 * Conecta el overlay con PointerLockControls:
 *   • lock   → ocultar overlay (inicio del juego)
 *   • unlock → mostrar overlay (pausa / ESC)
 *   • click  → solicitar bloqueo del puntero
 *
 * @param {object} controls — PointerLockControls
 */
export function initUI(controls) {
  controls.addEventListener('lock',   () => { overlayEl.style.display = 'none'; });
  controls.addEventListener('unlock', () => { overlayEl.style.display = 'flex'; });
  overlayEl.addEventListener('click', () => controls.lock());
}

// ═══════════════════════════════════════════════════════════════
//  🖥️  ACTUALIZACIÓN DEL HUD — llamar cada frame
// ═══════════════════════════════════════════════════════════════

/**
 * Refresca todos los paneles del HUD con los datos actuales.
 *
 * @param {object}      player      — Estado del jugador (player.js)
 * @param {Map}         blockMap    — Mapa del mundo (world.js)
 * @param {object|null} targetBlock — Bloque apuntado {x,y,z} o null
 */
export function updateHUD(player, blockMap, targetBlock) {
  elHX.textContent = player.position.x.toFixed(1);
  elHY.textContent = player.position.y.toFixed(1);
  elHZ.textContent = player.position.z.toFixed(1);
  elHB.textContent = blockMap.size;

  elBI.textContent = targetBlock
    ? `(${targetBlock.x}, ${targetBlock.y}, ${targetBlock.z})`
    : '—';

  elVY.textContent = player.velocity.y.toFixed(2);
  elSG.textContent = player.isOnGround ? '✓' : '✗';
}