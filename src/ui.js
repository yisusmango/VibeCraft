import { sendChatMessage } from './multiplayer.js';
import { MATERIALS }       from './world.js';

// ═══════════════════════════════════════════════════════════════
//  src/ui.js
//  Responsabilidades:
//    • Overlay de inicio / pausa
//    • HUD de coordenadas y contador de bloques
//    • Hotbar: 9 slots dinámicos renderizados desde inventoryState
//    • Sistema de Inventario Creative Mode (tecla E)
//      – Catálogo: todos los bloques de MATERIALS (read-only, infinito)
//        ↳ Clic con cursor vacío  → clonar bloque al cursor
//        ↳ Clic con cursor lleno  → DESTRUIR ítem del cursor (Trash)
//      – Inventario: 27 slots internos (índices 9-35)
//      – Hotbar strip: 9 slots sincronizados con el HUD (índices 0-8)
//      – Cursor item: bloque "pegado" al ratón (click-to-drag)
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

// ── Estado: chat e inventario ─────────────────────────────────────
//  isChatting     → true mientras el input de chat está activo.
//                   Previene que controls.unlock() abra el menú de pausa.
//  isInventoryOpen → true mientras el overlay de inventario está visible.
//                    Se pone a true ANTES de llamar controls.unlock() para
//                    que el listener 'unlock' no muestre el menú de pausa.
let isChatting      = false;
let isInventoryOpen = false;

// ═══════════════════════════════════════════════════════════════
//  🎒  INVENTARIO — ESTADO GLOBAL
//  ─────────────────────────────────────────────────────────────
//  inventoryState es el único source-of-truth para el contenido
//  del inventario y del hotbar.
//
//  Índices 0-8  → Hotbar (sincronizados con la barra del HUD)
//  Índices 9-35 → Inventario interno (27 slots)
//
//  Cada elemento: { type: string } | null
//    – null  → slot vacío
//    – type  → clave de MATERIALS (e.g. 'grass', 'stone', etc.)
// ═══════════════════════════════════════════════════════════════

let inventoryState    = new Array(36).fill(null);
let cursorItem        = null;   // bloque actualmente "pegado" al cursor
let selectedSlotIndex = 0;     // índice del slot activo en el hotbar (0-8)

// ── Bloques por defecto del Hotbar ───────────────────────────────
//  HOTBAR_BLOCKS se mantiene como export para compatibilidad con
//  otros módulos que puedan importarlo. Solo se usa para la
//  inicialización; a partir de aquí, inventoryState es el master.
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

// Rellenar los primeros 9 slots del inventario con los bloques por defecto
HOTBAR_BLOCKS.forEach((type, i) => { inventoryState[i] = { type }; });

/**
 * Devuelve el tipo de bloque del slot activo del hotbar.
 * Importado por interaction.js para usarlo en placeBlock().
 * Retorna null si el slot activo está vacío (sin bloque seleccionado).
 * @returns {string|null}
 */
export const getCurrentBlockType = () => inventoryState[selectedSlotIndex]?.type ?? null;

// ═══════════════════════════════════════════════════════════════
//  🎨  PINTORES DE ICONOS — Canvas 2D (sin imágenes externas)
//  ─────────────────────────────────────────────────────────────
//  Cada función recibe (ctx, w, h) y dibuja el icono del bloque
//  sobre un canvas de WxH píxeles.
//  Misma paleta que las texturas 3D → coherencia visual world/UI.
// ═══════════════════════════════════════════════════════════════

/** Rellena una región con píxeles aleatorios de una paleta. */
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
    // grietas decorativas
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
  water(ctx, w, h) {
    ctx.fillStyle = 'rgba(30,100,210,0.80)';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = `rgba(${50 + (Math.random() * 40) | 0},${120 + (Math.random() * 60) | 0},${200 + (Math.random() * 55) | 0},0.6)`;
      ctx.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 2, 1);
    }
    ctx.fillStyle = 'rgba(140,210,255,0.35)';
    ctx.fillRect(0, 0, w, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(3, 3, 5, 2);
  },
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

/** Fallback: bloque desconocido → violeta ("missing texture") */
function paintUnknown(ctx, w, h) {
  ctx.fillStyle = '#8b00ff';
  ctx.fillRect(0, 0, w, h);
  // Cuadrícula de debug 2x2
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, (w / 2) | 0, (h / 2) | 0);
  ctx.fillRect((w / 2) | 0, (h / 2) | 0, w - ((w / 2) | 0), h - ((h / 2) | 0));
}

// ═══════════════════════════════════════════════════════════════
//  🏗️  HOTBAR — Renderizado dinámico desde inventoryState[0..8]
//  ─────────────────────────────────────────────────────────────
//  buildHotbar() reconstruye el DOM del #hotbar completo cada vez
//  que el inventario cambia. Es seguro porque el hotbar tiene solo
//  9 nodos y se llama con poca frecuencia (interacciones del usuario).
// ═══════════════════════════════════════════════════════════════

function buildHotbar() {
  const hotbar = document.getElementById('hotbar');
  if (!hotbar) return;
  hotbar.innerHTML = '';

  for (let i = 0; i < 9; i++) {
    const item = inventoryState[i];
    const slot = document.createElement('div');
    slot.className    = 'hotbar-slot' + (i === selectedSlotIndex ? ' selected' : '');
    slot.dataset.slot = String(i);

    if (item) {
      const canvas  = document.createElement('canvas');
      canvas.width  = 36;
      canvas.height = 36;
      const ctx     = canvas.getContext('2d');
      (ICON_PAINTERS[item.type] ?? paintUnknown)(ctx, 36, 36);
      slot.appendChild(canvas);
    }

    // Número de tecla (1-9) en esquina inferior-derecha
    const num = document.createElement('span');
    num.className   = 'slot-number';
    num.textContent = String(i + 1);
    slot.appendChild(num);

    hotbar.appendChild(slot);
  }
}

/**
 * Actualiza el resaltado visual del slot seleccionado en el hotbar del HUD.
 * Opera directamente sobre el DOM con classList para evitar un rebuild completo.
 */
function setSlot(index) {
  const slots = document.querySelectorAll('.hotbar-slot');
  slots[selectedSlotIndex]?.classList.remove('selected');
  selectedSlotIndex = index;
  slots[selectedSlotIndex]?.classList.add('selected');
}

// ═══════════════════════════════════════════════════════════════
//  🧱  INVENTARIO — Sistema Creative Mode
//  ─────────────────────────────────────────────────────────────
//  Flujo de interacción (click-to-drag, sin HTML5 Drag & Drop):
//
//  1. Click en el CATÁLOGO (listener único delegado en #creative-catalog):
//     a) cursorItem !== null → TRASH: destruir el ítem del cursor.
//        Aplica a CUALQUIER clic dentro del área del catálogo —
//        ya sea sobre un slot con bloque o en un gap vacío del grid.
//     b) cursorItem === null → CLONE: buscar el .inv-slot--catalog más
//        cercano con e.target.closest(), leer su dataset.block y clonar.
//        Si el clic cayó en un gap (sin slot padre), es un no-op silencioso.
//
//  2. Click en slot del Inventario / Hotbar strip:
//     a) cursorItem != null + slot vacío    → depositar (swap ∅ ↔ item)
//     b) cursorItem != null + slot ocupado  → intercambiar (swap)
//     c) cursorItem == null + slot ocupado  → recoger (pick-up)
//     d) cursorItem == null + slot vacío    → no-op
//
//  3. Click en el overlay oscuro (fuera del panel):
//     cursorItem = null  (tirar el ítem al "suelo") + closeInventory()
//
//  ─────────────────────────────────────────────────────────────
//  ⚠️  POR QUÉ UN ÚNICO LISTENER DELEGADO EN EL CATÁLOGO:
//  ─────────────────────────────────────────────────────────────
//  Si hubiese un listener por cada .inv-slot--catalog Y uno más
//  en el contenedor #creative-catalog, el evento de clic bubblería
//  slot → contenedor dentro de la misma pulsación:
//
//    1. Slot listener: cursorItem era null → lo pone a { type: 'grass' }
//    2. Container listener: cursorItem ya != null → lo borra inmediatamente
//
//  Resultado: el ítem nunca llega al cursor. Race condition garantizada.
//
//  La delegación en el contenedor elimina ese problema: hay un único
//  punto de decisión, sin interferencias de bubbling.
//
//  ─────────────────────────────────────────────────────────────
//  Optimización DOM: renderInventorySlot(index) hace actualización
//  quirúrgica de UN slot; no reconstruye el grid completo.
//  buildHotbar() solo se llama cuando un slot 0-8 cambia.
// ═══════════════════════════════════════════════════════════════

/**
 * Crea un <canvas> de 36×36 con el icono del bloque pintado.
 * Se reutiliza para hotbar, inventario y cursor-item.
 * @param {string} blockType — clave de MATERIALS
 * @returns {HTMLCanvasElement}
 */
function createSlotCanvas(blockType) {
  const canvas  = document.createElement('canvas');
  canvas.width  = 36;
  canvas.height = 36;
  const ctx     = canvas.getContext('2d');
  (ICON_PAINTERS[blockType] ?? paintUnknown)(ctx, 36, 36);
  return canvas;
}

/**
 * Sincroniza el div #cursor-item con el estado de cursorItem.
 * Si cursorItem es null, oculta el div y limpia su contenido.
 * Si cursorItem tiene datos, renderiza el canvas del bloque correspondiente.
 */
function updateCursorItem() {
  const el = document.getElementById('cursor-item');
  if (!el) return;

  if (cursorItem) {
    el.innerHTML = '';
    el.appendChild(createSlotCanvas(cursorItem.type));
    el.style.display = 'block';
  } else {
    el.style.display = 'none';
  }
}

/**
 * Actualización quirúrgica de UN slot en el panel de inventario.
 * Encuentra el .inv-slot[data-index="N"] en el DOM, limpia su canvas
 * y lo repinta con el contenido actual de inventoryState[index].
 * No reconstruye el grid → cero GC innecesario.
 * @param {number} index — índice en inventoryState (0-35)
 */
function renderInventorySlot(index) {
  const slotEl = document.querySelector(`.inv-slot[data-index="${index}"]`);
  if (!slotEl) return;

  // Eliminar solo el canvas (preservar otros hijos si los hubiera)
  const existing = slotEl.querySelector('canvas');
  if (existing) existing.remove();

  const item = inventoryState[index];
  if (item) slotEl.appendChild(createSlotCanvas(item.type));
}

/**
 * Handler de click compartido por todos los .inv-slot del panel
 * de inventario y del hotbar strip (NO del catálogo, que usa delegación).
 * Implementa la lógica de pick-up / deposit / swap.
 * @param {MouseEvent} e
 */
function handleInventorySlotClick(e) {
  const index    = parseInt(e.currentTarget.dataset.index, 10);
  const slotItem = inventoryState[index];   // item actual en este slot

  if (cursorItem !== null) {
    // Tenemos un ítem en el cursor → depositar o intercambiar.
    // Si slotItem es null, la "swap" produce null en cursorItem (correcto).
    inventoryState[index] = { type: cursorItem.type };
    cursorItem = slotItem ? { type: slotItem.type } : null;
  } else if (slotItem !== null) {
    // Cursor vacío + slot ocupado → recoger el ítem
    cursorItem = { type: slotItem.type };
    inventoryState[index] = null;
  }
  // Cursor vacío + slot vacío → no-op

  updateCursorItem();
  renderInventorySlot(index);

  // Si el slot pertenece al hotbar (0-8), sincronizar el HUD del juego
  if (index < 9) buildHotbar();
}

/**
 * Crea un elemento .inv-slot para el panel de inventario o el hotbar strip.
 * Incluye el canvas del bloque (si existe en inventoryState)
 * y registra el click handler de pick-up/deposit/swap.
 * @param {number} index — índice en inventoryState (0-35)
 * @returns {HTMLDivElement}
 */
function createInventorySlot(index) {
  const slot = document.createElement('div');
  slot.className     = 'inv-slot';
  slot.dataset.index = String(index);

  const item = inventoryState[index];
  if (item) slot.appendChild(createSlotCanvas(item.type));

  slot.addEventListener('click', handleInventorySlotClick);
  return slot;
}

/**
 * Crea un elemento .inv-slot--catalog para el Catálogo Creativo.
 *
 * IMPORTANTE: Este slot NO registra ningún listener de click propio.
 * Toda la lógica de interacción (trash / clone) vive en un único
 * listener delegado registrado en el contenedor #creative-catalog
 * dentro de buildInventoryPanel(). Esto evita la race condition de
 * bubbling que surgiría si coexistieran listeners en slot y contenedor.
 *
 * @param {string} blockType — clave de MATERIALS
 * @returns {HTMLDivElement}
 */
function createCatalogSlot(blockType) {
  const slot = document.createElement('div');
  slot.className     = 'inv-slot inv-slot--catalog';
  slot.dataset.block = blockType;
  slot.title         = blockType;   // tooltip nativo con el nombre del bloque
  slot.appendChild(createSlotCanvas(blockType));
  // ⚠️ Sin addEventListener aquí — el listener delegado vive en el contenedor.
  return slot;
}

/**
 * Construye el panel de inventario completo en el DOM.
 * Se llama UNA sola vez en initUI() para evitar acumulación de
 * event listeners en opens/closes subsiguientes.
 *
 * Secciones construidas:
 *   • #creative-catalog — un slot por cada clave en MATERIALS
 *                         + 1 listener delegado (trash / clone)
 *   • #inv-main-grid    — slots 9-35 (inventario interno, 9×3)
 *   • #inv-hotbar-grid  — slots 0-8  (hotbar strip, 9×1)
 */
function buildInventoryPanel() {

  // ── Catálogo Creativo ────────────────────────────────────────────
  const catalogEl = document.getElementById('creative-catalog');
  if (catalogEl) {
    catalogEl.innerHTML = '';
    Object.keys(MATERIALS).forEach(blockType => {
      catalogEl.appendChild(createCatalogSlot(blockType));
    });

    // ── Listener delegado único para TODA el área del catálogo ─────
    //
    //  Casos cubiertos por este único handler:
    //
    //  CASO A — cursorItem !== null (tengo un ítem en el cursor):
    //    → TRASH. Se aplica sea cual sea el e.target dentro del catálogo:
    //      • Clic sobre el canvas de un bloque (e.target = <canvas>)
    //      • Clic sobre el div de un slot     (e.target = .inv-slot--catalog)
    //      • Clic en un gap vacío del grid    (e.target = #creative-catalog)
    //    En todos los casos: cursorItem = null + updateCursorItem().
    //
    //  CASO B — cursorItem === null (cursor vacío):
    //    → CLONE si el clic fue sobre un slot de bloque.
    //      e.target.closest('.inv-slot--catalog') sube desde el canvas
    //      (o desde el propio slot) hasta encontrar el div del slot,
    //      lee su dataset.block y clona el bloque al cursor.
    //    → NO-OP si el clic fue en un gap (closest retorna null).
    catalogEl.addEventListener('click', (e) => {

      if (cursorItem !== null) {
        // ── TRASH ──────────────────────────────────────────────────
        // El jugador sostiene un ítem y hace clic en cualquier parte
        // del catálogo → destruir el ítem (comportamiento Minecraft Creative).
        cursorItem = null;
        updateCursorItem();
        return;
      }

      // ── CLONE ──────────────────────────────────────────────────
      // Cursor vacío → intentar recoger el bloque clickeado.
      // closest() sube por el DOM desde e.target hasta encontrar un
      // .inv-slot--catalog; retorna null si el clic cayó en un gap vacío.
      const slotEl = e.target.closest('.inv-slot--catalog');
      if (!slotEl) return;   // gap vacío + cursor vacío → no-op

      cursorItem = { type: slotEl.dataset.block };
      updateCursorItem();
    });
  }

  // ── Grid de Inventario (slots 9-35) ──────────────────────────────
  const mainGridEl = document.getElementById('inv-main-grid');
  if (mainGridEl) {
    mainGridEl.innerHTML = '';
    for (let i = 9; i < 36; i++) {
      mainGridEl.appendChild(createInventorySlot(i));
    }
  }

  // ── Strip del Hotbar en el panel (slots 0-8) ─────────────────────
  const hotbarGridEl = document.getElementById('inv-hotbar-grid');
  if (hotbarGridEl) {
    hotbarGridEl.innerHTML = '';
    for (let i = 0; i < 9; i++) {
      hotbarGridEl.appendChild(createInventorySlot(i));
    }
  }
}

/**
 * Abre el inventario: muestra el overlay y libera el Pointer Lock.
 *
 * ORDEN CRÍTICO: isInventoryOpen = true ANTES de controls.unlock().
 * El listener 'unlock' de PointerLockControls tiene la guardia:
 *   if (!isChatting && !isInventoryOpen) overlayEl.style.display = 'flex'
 * Si invirtiéramos el orden, unlock() dispararía el menú de pausa.
 *
 * @param {import('three/addons/controls/PointerLockControls.js').PointerLockControls} controls
 */
function openInventory(controls) {
  isInventoryOpen = true;                                            // ← primero
  document.getElementById('inventory-overlay').style.display = 'flex';
  document.body.classList.add('inventory-active');
  controls.unlock();                                                 // ← después
}

/**
 * Cierra el inventario: descarta el cursor-item, oculta el overlay
 * y reactiva el Pointer Lock con un delay de 10 ms.
 *
 * El delay es necesario para que el navegador registre el gesto del
 * usuario antes de que requestPointerLock() se llame de nuevo.
 * 10 ms es suficiente (mismo valor que usa el subsistema de chat).
 *
 * @param {import('three/addons/controls/PointerLockControls.js').PointerLockControls} controls
 */
function closeInventory(controls) {
  cursorItem = null;
  updateCursorItem();
  isInventoryOpen = false;
  document.getElementById('inventory-overlay').style.display = 'none';
  document.body.classList.remove('inventory-active');
  setTimeout(() => controls.lock(), 10);
}

// ═══════════════════════════════════════════════════════════════
//  👤  SISTEMA DE SKINS — FileReader + localStorage
//  ─────────────────────────────────────────────────────────────
//  Flujo: btn-upload-skin → dispara skin-input (file picker)
//         → FileReader.readAsDataURL() → guarda Base64
//         → localStorage.setItem('vibe_skin', base64)
//  Sin base de datos, sin servidor. Persiste entre sesiones.
// ═══════════════════════════════════════════════════════════════

function initSkinUploader() {
  const btnUpload = document.getElementById('btn-upload-skin');
  const skinInput = document.getElementById('skin-input');

  if (!btnUpload || !skinInput) return;

  // El botón visible dispara el file picker nativo (input oculto)
  btnUpload.addEventListener('click', () => {
    skinInput.value = '';   // reset para permitir recargar el mismo archivo
    skinInput.click();
  });

  skinInput.addEventListener('change', () => {
    const file = skinInput.files?.[0];
    if (!file) return;

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
//  evento 'chatMessage' del servidor.
// ═══════════════════════════════════════════════════════════════

/**
 * Añade un mensaje al panel de chat con formato '[username]: message'.
 * @param {string} username
 * @param {string} message
 */
export function addChatMessage(username, message) {
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const div = document.createElement('div');
  const safeName = String(username).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safeMsg  = String(message).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  div.innerHTML  = `<b>[${safeName}]</b>: ${safeMsg}`;
  container.appendChild(div);

  // Auto-scroll: mostrar siempre el mensaje más reciente
  container.scrollTop = container.scrollHeight;
}

// ═══════════════════════════════════════════════════════════════
//  👤  SISTEMA DE USERNAME — localStorage + sanitización en tiempo real
// ═══════════════════════════════════════════════════════════════

/**
 * Devuelve el username guardado, o null si no existe todavía.
 * @returns {string|null}
 */
export function getSavedUsername() {
  return localStorage.getItem('vibe_username');
}

function initUsernameInput() {
  const input = document.getElementById('username-input');
  if (!input) return;

  const saved = localStorage.getItem('vibe_username');
  input.value = saved ?? `Player${Math.floor(Math.random() * 9000) + 1000}`;

  // Sanitizar y persistir en cada pulsación de tecla
  input.addEventListener('input', function () {
    this.value = this.value.replace(/[^a-zA-Z0-9_]/g, '');
    localStorage.setItem('vibe_username', this.value);
  });
}

// ═══════════════════════════════════════════════════════════════
//  🚀  INICIALIZACIÓN PÚBLICA
//  ─────────────────────────────────────────────────────────────
//  Orden de inicialización:
//    1. Conectar eventos de PointerLockControls (lock / unlock)
//    2. Construir hotbar del HUD desde inventoryState
//    3. Construir panel de inventario (una sola vez)
//    4. Registrar mouse tracking para cursor-item
//    5. Registrar click en overlay para cerrar inventario
//    6. Registrar handler de teclado unificado (E, Escape, T, 1-9)
//    7. Registrar scroll de rueda para el hotbar
//    8. Inicializar subsistemas de skin y username
//    9. Inicializar subsistema de chat
// ═══════════════════════════════════════════════════════════════

/**
 * Inicializa toda la UI. Llamar una sola vez desde main.js.
 * @param {import('three/addons/controls/PointerLockControls.js').PointerLockControls} controls
 */
export function initUI(controls) {

  // ── 1. PointerLock: lock / unlock ─────────────────────────────
  controls.addEventListener('lock', () => {
    overlayEl.style.display = 'none';
  });

  controls.addEventListener('unlock', () => {
    // Guardia doble: no mostrar el menú de pausa si el unlock fue
    // causado por el chat (isChatting) o por el inventario (isInventoryOpen).
    if (!isChatting && !isInventoryOpen) {
      overlayEl.style.display = 'flex';
    }
  });

  // Botón "Volver al juego" en el menú de pausa
  document.getElementById('btn-resume').addEventListener('click', () => {
    controls.lock();
  });

  // ── 2. Hotbar del HUD ─────────────────────────────────────────
  buildHotbar();

  // ── 3. Panel de inventario (se construye UNA VEZ) ─────────────
  buildInventoryPanel();

  // ── 4. Mouse tracking: mantener #cursor-item bajo el cursor ────
  //  Usamos passive:true → el navegador puede optimizar el scroll.
  //  El offset de 20px centra el icono de 40px en el puntero.
  document.addEventListener('mousemove', (e) => {
    const el = document.getElementById('cursor-item');
    if (el && el.style.display !== 'none') {
      el.style.left = (e.clientX - 20) + 'px';
      el.style.top  = (e.clientY - 20) + 'px';
    }
  }, { passive: true });

  // ── 5. Click en el fondo del overlay: tirar ítem + cerrar ──────
  //  e.target === invOverlay (no el panel interior) → clic fuera del panel.
  //  closeInventory() ya limpia cursorItem internamente.
  const invOverlay = document.getElementById('inventory-overlay');
  invOverlay.addEventListener('click', (e) => {
    if (e.target === invOverlay) {
      closeInventory(controls);
    }
  });

  // ── 6. Handler de teclado unificado ───────────────────────────
  //
  //  Teclas gestionadas (por orden de prioridad):
  //    • 'E'       → toggle inventario (solo si no está en chat)
  //    • 'Escape'  → cerrar inventario si está abierto
  //    • 'T'       → abrir chat (solo si controls.isLocked y no en inventario)
  //    • '1'-'9'   → cambiar slot del hotbar (guard: no en input de texto)
  //
  //  Por qué un solo listener: minimizar el número de event listeners
  //  globales. Cada listener adicional tiene un coste de registro en
  //  el event loop aunque la tecla no sea la correcta.
  document.addEventListener('keydown', (e) => {

    // ── Tecla E: toggle inventario ─────────────────────────────
    if (e.code === 'KeyE' && !isChatting) {
      if (isInventoryOpen) {
        closeInventory(controls);
        return;
      }
      if (controls.isLocked) {
        e.preventDefault();
        openInventory(controls);
        return;
      }
    }

    // ── Escape: cerrar inventario si está abierto ──────────────
    //  Cuando el inventario está abierto, el pointer ya está libre,
    //  así que Escape no dispara el evento 'unlock' del PointerLock.
    //  Interceptamos aquí para cerrar limpiamente.
    if (e.code === 'Escape' && isInventoryOpen) {
      closeInventory(controls);
      return;
    }

    // ── Tecla T: abrir chat ────────────────────────────────────
    //  Solo si: el jugador tiene control (isLocked) Y no está en inventario
    if (e.code === 'KeyT' && controls.isLocked && !isInventoryOpen) {
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

    // ── Teclas 1-9: cambiar slot del hotbar ───────────────────
    //  Guard: no cambiar slot si el foco está en un <input> de texto
    //  (username, chat u otro). Evita que escribir "1" seleccione el slot.
    if (document.activeElement.tagName === 'INPUT') return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= 9) {
      e.preventDefault();
      setSlot(n - 1);
    }
  });

  // ── 7. Scroll de rueda: navegar el Hotbar ─────────────────────
  //  Bloqueado mientras el inventario está abierto para no cambiar
  //  el slot activo accidentalmente al hacer scroll en el catálogo.
  document.addEventListener('wheel', (e) => {
    if (isInventoryOpen) return;
    e.preventDefault();
    const dir  = e.deltaY > 0 ? 1 : -1;
    const next = ((selectedSlotIndex + dir) % 9 + 9) % 9;
    setSlot(next);
  }, { passive: false });

  // ── 8. Subsistemas de skin y username ─────────────────────────
  initSkinUploader();
  initUsernameInput();

  // ── 9. Chat: cerrar con Enter / Escape ────────────────────────
  //  closeChat() usa un delay de 10 ms para que el evento Escape
  //  no burbujee y abra el menú de pausa.
  function closeChat(inputEl) {
    inputEl.value         = '';
    inputEl.style.display = 'none';
    isChatting = false;
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
//  🖥️  ACTUALIZACIÓN DEL HUD — llamar cada frame desde main.js
// ═══════════════════════════════════════════════════════════════

/**
 * Actualiza las lecturas del HUD: posición, bloques y bloque apuntado.
 * Se llama en el bucle principal de requestAnimationFrame.
 * @param {object}      player      — objeto del jugador (position, velocity, isOnGround)
 * @param {Map}         blockMap    — mapa de bloques del mundo
 * @param {object|null} targetBlock — bloque bajo el cursor de interacción
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