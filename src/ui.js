// ═══════════════════════════════════════════════════════════════
//  src/ui.js
//  Responsabilidades:
//    • Overlay de inicio / pausa
//    • HUD de coordenadas y contador de bloques
//    • Hotbar: 9 slots con iconos procedurales, selección 1-9
//    • Exporta getCurrentBlockType() para interaction.js
//    • Sistema de Skins: FileReader + localStorage (sin base de datos)
// ═══════════════════════════════════════════════════════════════

// ── Referencias DOM fijas ────────────────────────────────────────
const elHX      = document.getElementById('hx');
const elHY      = document.getElementById('hy');
const elHZ      = document.getElementById('hz');
const elHB      = document.getElementById('hb');
const elBI      = document.getElementById('bi');
const elVY      = document.getElementById('svy');
const elSG      = document.getElementById('sg');
const overlayEl = document.getElementById('overlay');

// ═══════════════════════════════════════════════════════════════
//  🎒  HOTBAR — DEFINICIÓN DE SLOTS
//  Modifica este array para reordenar o cambiar los bloques.
//  Los 9 valores deben coincidir con claves en MATERIALS (world.js).
// ═══════════════════════════════════════════════════════════════

export const HOTBAR_BLOCKS = [
  'grass',   // tecla 1
  'dirt',    // tecla 2
  'stone',   // tecla 3
  'wood',    // tecla 4
  'leaves',  // tecla 5
  'sand',    // tecla 6
  'glass',   // tecla 7
  'torch',   // tecla 8  ← antorcha con luz dinámica
  'stone',   // tecla 9
];

// Slot seleccionado actualmente (0-indexado)
let currentSlot = 0;

/**
 * Devuelve el tipo de bloque del slot activo.
 * Importado por interaction.js para usarlo en placeBlock().
 * @returns {string} — clave de MATERIALS, ej: 'grass', 'stone', etc.
 */
export const getCurrentBlockType = () => HOTBAR_BLOCKS[currentSlot];

// ═══════════════════════════════════════════════════════════════
//  🎨  PINTORES DE ICONOS — Canvas 2D (sin imágenes externas)
//  Cada función recibe (ctx, w, h) y dibuja el icono del bloque.
//  Usamos la misma paleta de colores que las texturas 3D para
//  coherencia visual entre el mundo y el inventario.
// ═══════════════════════════════════════════════════════════════

/** Rellena región con píxeles aleatorios de una paleta. */
function iconNoise(ctx, x0, y0, w, h, palette) {
  for (let y = y0; y < y0 + h; y++)
    for (let x = x0; x < x0 + w; x++) {
      ctx.fillStyle = palette[(Math.random() * palette.length) | 0];
      ctx.fillRect(x, y, 1, 1);
    }
}

const ICON_PAINTERS = {
  grass(ctx, w, h) {
    // mitad inferior: tierra
    iconNoise(ctx, 0, (h * 0.45) | 0, w, h - ((h * 0.45) | 0),
      ['#8B5E3C','#7a4d2b','#9a6e4c']);
    // mitad superior: hierba
    iconNoise(ctx, 0, 0, w, (h * 0.45) | 0,
      ['#5d8a3c','#4a7a2b','#6a9a49','#3d6a2b']);
  },
  dirt(ctx, w, h) {
    iconNoise(ctx, 0, 0, w, h, ['#8B5E3C','#7a4d2b','#9a6e4c','#6a3d1c']);
  },
  stone(ctx, w, h) {
    iconNoise(ctx, 0, 0, w, h, ['#888','#777','#999','#6e6e6e','#aaa']);
    // grieta decorativa
    ctx.fillStyle = '#505050';
    ctx.fillRect((w * 0.3) | 0, (h * 0.2) | 0, 1, (h * 0.4) | 0);
    ctx.fillRect((w * 0.6) | 0, (h * 0.5) | 0, 1, (h * 0.3) | 0);
  },
  wood(ctx, w, h) {
    iconNoise(ctx, 0, 0, w, h, ['#8B6340','#7a5230','#9a7352','#6e4828']);
    // vetas verticales
    const step = Math.max(1, (w / 4) | 0);
    for (let x = 0; x < w; x += step) {
      ctx.fillStyle = 'rgba(0,0,0,0.20)';
      ctx.fillRect(x, 0, 1, h);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(0, 0, w, 2);
    ctx.fillRect(0, h - 2, w, 2);
  },
  leaves(ctx, w, h) {
    iconNoise(ctx, 0, 0, w, h, ['#2d6e1e','#1f5214','#3a7e28','#255c18','#4a8a32']);
    for (let i = 0; i < 8; i++) {
      ctx.fillStyle = 'rgba(120,220,80,0.32)';
      ctx.fillRect((Math.random() * (w - 2)) | 0, (Math.random() * (h - 2)) | 0, 2, 2);
    }
  },
  sand(ctx, w, h) {
    iconNoise(ctx, 0, 0, w, h, ['#DDD06A','#ccc060','#e8da78','#d4ca64']);
  },
  glass(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(180,220,242,0.38)';
    ctx.fillRect(0, 0, w, h);
    // bordes bevel
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(0, 0, w, 2); ctx.fillRect(0, 0, 2, h);
    ctx.fillStyle = 'rgba(200,235,255,0.50)';
    ctx.fillRect(0, h - 2, w, 2); ctx.fillRect(w - 2, 0, 2, h);
    // brillo especular
    ctx.fillStyle = 'rgba(255,255,255,1)';
    ctx.fillRect(2, 2, 4, 4);
  },

  // ── Antorcha (torch) ───────────────────────────────────────────
  torch(ctx, w, h) {
    const cx = (w / 2) | 0;

    // Palo: rectángulo marrón oscuro de 4px de ancho
    ctx.fillStyle = '#6b3a1f';
    ctx.fillRect(cx - 2, (h * 0.38) | 0, 4, (h * 0.56) | 0);
    // Veta central del palo (ilusión de profundidad)
    ctx.fillStyle = 'rgba(255,160,60,0.25)';
    ctx.fillRect(cx,     (h * 0.38) | 0, 1, (h * 0.56) | 0);

    // Llama exterior: cuadrado amarillo
    ctx.fillStyle = '#ffcc00';
    ctx.fillRect(cx - 4, (h * 0.08) | 0, 9, (h * 0.34) | 0);
    // Llama media: naranja intenso (capa interior)
    ctx.fillStyle = '#ff8800';
    ctx.fillRect(cx - 2, (h * 0.12) | 0, 6, (h * 0.24) | 0);
    // Núcleo blanco-amarillo (punto más caliente)
    ctx.fillStyle = '#ffffaa';
    ctx.fillRect(cx - 1, (h * 0.15) | 0, 3, (h * 0.12) | 0);
  },
};

// ── Fallback: bloque desconocido → violeta ───────────────────────
function paintUnknown(ctx, w, h) {
  ctx.fillStyle = '#8b00ff';
  ctx.fillRect(0, 0, w, h);
}

// ═══════════════════════════════════════════════════════════════
//  🏗️  GENERACIÓN DINÁMICA DEL HOTBAR EN EL DOM
// ═══════════════════════════════════════════════════════════════

function buildHotbar() {
  const hotbar = document.getElementById('hotbar');
  hotbar.innerHTML = '';   // limpiar por si se llama más de una vez

  HOTBAR_BLOCKS.forEach((blockType, i) => {
    const slot = document.createElement('div');
    slot.className   = 'hotbar-slot' + (i === 0 ? ' selected' : '');
    slot.dataset.slot = String(i);

    // ── Icono: canvas de 36×36 dibujado con el pintor del bloque ──
    const canvas  = document.createElement('canvas');
    canvas.width  = 36;
    canvas.height = 36;
    const ctx     = canvas.getContext('2d');
    const painter = ICON_PAINTERS[blockType] ?? paintUnknown;
    painter(ctx, 36, 36);
    slot.appendChild(canvas);

    // ── Etiqueta de número (1-9) en la esquina inferior-derecha ──
    const num = document.createElement('span');
    num.className   = 'slot-number';
    num.textContent = String(i + 1);
    slot.appendChild(num);

    hotbar.appendChild(slot);
  });
}

/** Actualiza el resaltado visual del slot seleccionado. */
function setSlot(index) {
  const slots = document.querySelectorAll('.hotbar-slot');
  slots[currentSlot]?.classList.remove('selected');
  currentSlot = index;
  slots[currentSlot]?.classList.add('selected');
}

// ═══════════════════════════════════════════════════════════════
//  👤  SISTEMA DE SKINS — FileReader + localStorage
//  Flujo: btn-upload-skin → dispara skin-input (file picker)
//         → FileReader.readAsDataURL() → guarda Base64
//         → localStorage.setItem('vibe_skin', base64)
//  Sin base de datos, sin servidor. Persiste entre sesiones.
// ═══════════════════════════════════════════════════════════════

/**
 * Inicializa el subsistema de carga de skins.
 * Conecta el botón del menú con el input oculto y gestiona
 * la lectura asíncrona del archivo PNG mediante FileReader.
 */
function initSkinUploader() {
  const btnUpload = document.getElementById('btn-upload-skin');
  const skinInput = document.getElementById('skin-input');

  if (!btnUpload || !skinInput) return; // guardia: elementos opcionales

  // El botón visible dispara el file picker nativo (input oculto)
  btnUpload.addEventListener('click', () => {
    skinInput.value = '';   // reset para permitir recargar el mismo archivo
    skinInput.click();
  });

  // Cuando el usuario selecciona un archivo PNG
  skinInput.addEventListener('change', () => {
    const file = skinInput.files?.[0];
    if (!file) return;

    // Validación ligera: solo PNG, máximo 2 MB
    if (file.type !== 'image/png') {
      alert('⚠️ Solo se aceptan archivos PNG.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      alert('⚠️ El archivo supera el límite de 2 MB.');
      return;
    }

    const reader = new FileReader();

    reader.addEventListener('load', () => {
      const base64String = /** @type {string} */ (reader.result);

      try {
        localStorage.setItem('vibe_skin', base64String);
        alert(`✅ Skin "${file.name}" cargada correctamente.\nSe aplicará la próxima vez que entres al juego.`);
      } catch (storageError) {
        // Puede ocurrir si localStorage está lleno (quota exceeded)
        console.error('[VibeCraft] Error al guardar la skin:', storageError);
        alert('❌ No se pudo guardar la skin. El almacenamiento local podría estar lleno.');
      }
    });

    reader.addEventListener('error', () => {
      console.error('[VibeCraft] FileReader error:', reader.error);
      alert('❌ Error al leer el archivo. Intenta con otro PNG.');
    });

    reader.readAsDataURL(file);
  });
}

/**
 * Devuelve la skin guardada como Data URL, o null si no existe.
 * Úsala en main.js / player.js para aplicar la textura al modelo.
 * @returns {string|null}
 */
export function getSavedSkin() {
  return localStorage.getItem('vibe_skin');
}

// ═══════════════════════════════════════════════════════════════
//  🚀  INICIALIZACIÓN PÚBLICA
// ═══════════════════════════════════════════════════════════════

/**
 * Inicializa toda la UI:
 *   1. Conecta overlay ↔ PointerLockControls
 *   2. Construye los slots del Hotbar con sus iconos
 *   3. Registra teclas 1-9 para cambiar el slot activo
 *   4. Inicializa el sistema de carga de skins
 *
 * @param {object} controls — PointerLockControls
 */
export function initUI(controls) {
  // Overlay: se muestra al desbloquear el puntero (ESC), se oculta al bloquear
  controls.addEventListener('lock',   () => { overlayEl.style.display = 'none'; });
  controls.addEventListener('unlock', () => { overlayEl.style.display = 'flex'; });

  // ── btn-resume: "Volver al juego" → reactiva el PointerLock ────
  document.getElementById('btn-resume').addEventListener('click', () => {
    controls.lock();
  });

  // Hotbar
  buildHotbar();

  // Teclas 1-9: cambian el slot activo
  document.addEventListener('keydown', (e) => {
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= HOTBAR_BLOCKS.length) {
      e.preventDefault();
      setSlot(n - 1);
    }
  });

  // ── Scroll del ratón: navega el Hotbar de forma circular ──────────
  document.addEventListener('wheel', (e) => {
    e.preventDefault();
    const len  = HOTBAR_BLOCKS.length;
    const dir  = e.deltaY > 0 ? 1 : -1;
    const next = ((currentSlot + dir) % len + len) % len;
    setSlot(next);
  }, { passive: false });

  // ── Skin uploader ─────────────────────────────────────────────
  initSkinUploader();
}

// ═══════════════════════════════════════════════════════════════
//  🖥️  ACTUALIZACIÓN DEL HUD — llamar cada frame
// ═══════════════════════════════════════════════════════════════

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