// ═══════════════════════════════════════════════════════════════
//  src/storage.js
//  Motor de persistencia de VibeCraft — IndexedDB via Promesas
//  ─────────────────────────────────────────────────────────────
//  API PÚBLICA:
//    getAllWorlds()              → Promise<World[]>
//    saveWorld(id, name, blocks) → Promise<void>
//    loadWorld(id)              → Promise<World>
//    deleteWorld(id)            → Promise<void>
//
//  ESQUEMA del store "worlds":
//  {
//    id          : number    — Date.now() al crear (keyPath)
//    name        : string    — nombre elegido por el jugador
//    blocks      : string[]  — ["x,y,z:tipo", …]  (formato comprimido)
//    lastPlayed  : string    — ISO-8601 timestamp
//  }
//
//  DECISIONES DE DISEÑO:
//  • Usamos una única promesa `_dbReady` para abrir la BD una sola vez
//    y reutilizar la conexión en todas las llamadas posteriores.
//    Esto evita la penalización de latencia de abrir/cerrar IDBDatabase
//    repetidamente y protege contra condiciones de carrera en lecturas
//    consecutivas rápidas (ej. renderWorldsList → loadWorld).
//  • Todos los errores de IDB se convierten en rechazos de Promesa para
//    que el caller pueda usar try/catch o .catch() uniformemente.
//  • getAllWorlds() ordena en memoria (JS) en lugar de usar un índice IDB
//    ya que el número de mundos es pequeño y evita complejidad de schema.
// ═══════════════════════════════════════════════════════════════

const DB_NAME    = 'VibeCraftDB';
const DB_VERSION = 1;
const STORE      = 'worlds';

// ── Apertura única de la BD ──────────────────────────────────────
//  `_dbReady` se resuelve con el objeto IDBDatabase la primera vez
//  que cualquier función del módulo la necesite.
const _dbReady = new Promise((resolve, reject) => {
  const req = indexedDB.open(DB_NAME, DB_VERSION);

  // onupgradeneeded: se ejecuta solo al crear o cambiar de versión
  req.onupgradeneeded = (e) => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains(STORE)) {
      // keyPath: 'id' → cada registro se identifica por su propiedad id
      db.createObjectStore(STORE, { keyPath: 'id' });
    }
  };

  req.onsuccess = (e) => resolve(e.target.result);
  req.onerror   = (e) => reject(
    new Error(`[VibeCraft] No se pudo abrir IndexedDB: ${e.target.error}`)
  );
});

// ── Helper: ejecuta fn(store) dentro de una transacción y devuelve
//   una Promesa que se resuelve con el resultado del request IDB.
function _tx(mode, fn) {
  return _dbReady.then(db => new Promise((resolve, reject) => {
    const tx    = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    const req   = fn(store);

    // onsuccess del request individual (get, put, delete, getAll…)
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(
      new Error(`[VibeCraft] Error en transacción IDB: ${e.target.error}`)
    );
    // onerror de la transacción (ej. quota exceeded, disco lleno)
    tx.onerror = (e) => reject(
      new Error(`[VibeCraft] Error de transacción: ${e.target.error}`)
    );
  }));
}

// ═══════════════════════════════════════════════════════════════
//  📋  getAllWorlds
//  Retorna todos los mundos ordenados por lastPlayed desc (más
//  reciente primero), tal como muestra el Gestor de Mundos.
// ═══════════════════════════════════════════════════════════════
export async function getAllWorlds() {
  const worlds = await _tx('readonly', store => store.getAll());
  // Ordenar por fecha de última partida (más reciente → más antiguo)
  return (worlds ?? []).sort(
    (a, b) => new Date(b.lastPlayed) - new Date(a.lastPlayed)
  );
}

// ═══════════════════════════════════════════════════════════════
//  💾  saveWorld
//  Guarda o actualiza el mundo con el id dado.
//  `put()` de IDB hace upsert: inserta si no existe, actualiza si
//  existe (basándose en el keyPath 'id').
// ═══════════════════════════════════════════════════════════════
export async function saveWorld(id, name, blocks) {
  const record = {
    id,
    name,
    blocks,                          // string[]  "x,y,z:tipo"
    lastPlayed: new Date().toISOString(),
  };
  await _tx('readwrite', store => store.put(record));
}

// ═══════════════════════════════════════════════════════════════
//  📂  loadWorld
//  Retorna el objeto World completo o undefined si no existe.
// ═══════════════════════════════════════════════════════════════
export async function loadWorld(id) {
  return _tx('readonly', store => store.get(id));
}

// ═══════════════════════════════════════════════════════════════
//  🗑️  deleteWorld
//  Elimina el mundo por su id. No lanza error si no existía.
// ═══════════════════════════════════════════════════════════════
export async function deleteWorld(id) {
  await _tx('readwrite', store => store.delete(id));
}