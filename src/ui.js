import { sendChatMessage } from './multiplayer.js';

// ═══════════════════════════════════════════════════════════════
//  src/ui.js
//  Responsabilidades:
//    • Overlay de inicio / pausa
//    • HUD de coordenadas y contador de bloques
//    • Hotbar: 9 slots con iconos procedurales, selección 1-9
//    • Exporta getCurrentBlockType() para interaction.js
//    • Sistema de Skins: FileReader + localStorage (sin base de datos)
//    • Chat multijugador: addChatMessage() + panel #chat-container
//    • Sistema de Username: campo de texto con sanitización en tiempo real
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

// ── Estado del chat ───────────────────────────────────────────────
//  isChatting = true mientras el input de chat está abierto.
//  Previene que controls.unlock() muestre el menú de pausa cuando
//  el jugador pulsa T para abrir el chat.
let isChatting = false;

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
//  💬  SISTEMA DE CHAT — panel flotante en esquina inferior izquierda
//  ─────────────────────────────────────────────────────────────
//  addChatMessage() es llamada por multiplayer.js al recibir un
//  evento 'chatMessage' del servidor. Añade el mensaje al panel
//  y hace auto-scroll para mostrar siempre el más reciente.
//
//  El panel (#chat-container) se muestra/oculta con la tecla T.
//  Mientras está visible, el PointerLock se libera para que el
//  jugador pueda escribir. Enter envía y cierra; Escape cancela.
// ═══════════════════════════════════════════════════════════════

/**
 * Añade un mensaje al panel de chat con formato '[username]: message'.
 * Crea el div, lo inserta en #chat-messages y hace auto-scroll.
 * @param {string} username
 * @param {string} message
 */
export function addChatMessage(username, message) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const div = document.createElement('div');
  // Sanitizar para evitar inyección HTML — solo escapamos los caracteres críticos
  const safeName = String(username).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeMsg  = String(message).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  div.innerHTML  = `<b>[${safeName}]</b>: ${safeMsg}`;
  container.appendChild(div);

  // Auto-scroll: mostrar siempre el mensaje más reciente
  container.scrollTop = container.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════
//  👤  SISTEMA DE USERNAME — localStorage + sanitización en tiempo real
//  Flujo: al arrancar lee localStorage o genera 'Player'+random.
//         El evento 'input' sanitiza y persiste en tiempo real.
// ═══════════════════════════════════════════════════════════════

/**
 * Devuelve el username guardado, o null si no existe todavía.
 * Importado por multiplayer.js para incluirlo en updateProfile.
 * @returns {string|null}
 */
export function getSavedUsername() {
  return localStorage.getItem('vibe_username');
}

/**
 * Inicializa el campo de nombre de usuario:
 *   1. Rellena el input con el valor guardado o genera un nombre por defecto.
 *   2. Sanitiza en tiempo real (solo a-z, A-Z, 0-9, _).
 *   3. Persiste en localStorage en cada cambio.
 */
function initUsernameInput() {
  const input = document.getElementById('username-input');
  if (!input) return;

  // Cargar valor guardado o generar uno por defecto
  const saved = localStorage.getItem('vibe_username');
  input.value = saved ?? `Player${Math.floor(Math.random() * 9000) + 1000}`;

  // Sanitizar y persistir en cada pulsación de tecla
  input.addEventListener('input', function () {
    // Eliminar cualquier carácter que no sea alfanumérico o guión bajo
    this.value = this.value.replace(/[^a-zA-Z0-9_]/g, '');
    localStorage.setItem('vibe_username', this.value);
  });
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
  // Si el chat está activo, el unlock fue causado por nosotros (tecla T)
  // y NO debemos mostrar el menú de pausa.
  controls.addEventListener('unlock', () => { if (!isChatting) overlayEl.style.display = 'flex'; });

  // ── btn-resume: "Volver al juego" → reactiva el PointerLock ────
  document.getElementById('btn-resume').addEventListener('click', () => {
    controls.lock();
  });

  // Hotbar
  buildHotbar();

  // ── Teclas: T (chat) + 1-9 (hotbar) ──────────────────────────
  //  Un único listener unificado gestiona ambos grupos de teclas.
  //  La guardia INPUT permite escribir en username-input sin activar
  //  el hotbar. La rama T solo actúa si el PointerLock está activo.
  document.addEventListener('keydown', (e) => {
    // Tecla T: abrir chat (solo si el jugador está en control)
    if (e.code === 'KeyT' && controls.isLocked) {
      e.preventDefault();
      isChatting = true;
      controls.unlock();
      const input = document.getElementById('chat-input');
      if (input) {
        input.style.display = 'block';
        setTimeout(() => input.focus(), 10);
      }
      return;
    }

    // Teclas 1-9: cambiar slot del hotbar
    if (document.activeElement.tagName === 'INPUT') return;
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

  // ── Username input ────────────────────────────────────────────
  initUsernameInput();

  // ── Chat: cerrar con Enter / Escape ───────────────────────────
  //  closeChat() limpia el input, lo oculta, resetea isChatting y
  //  reactiva el PointerLock con un pequeño delay para que el evento
  //  Escape no propague y abra el menú de pausa.
  function closeChat(inputEl) {
    inputEl.value = '';
    inputEl.style.display = 'none';
    isChatting = false;
    // Delay de 10 ms: evita que Escape burbujee y dispare el menú de pausa
    setTimeout(() => controls.lock(), 10);
  }

  const chatInputEl = document.getElementById('chat-input');
  if (chatInputEl) {
    chatInputEl.addEventListener('keydown', (e) => {
      if (e.code === 'Enter') {
        e.stopPropagation();
        const val = e.target.value.trim();
        if (val) sendChatMessage(val);
        closeChat(e.target);
      } else if (e.code === 'Escape') {
        e.stopPropagation();
        closeChat(e.target);
      }
    });
  }
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