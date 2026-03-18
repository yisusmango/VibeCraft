// ═══════════════════════════════════════════════════════════════
//  src/particles.js  —  VibeCraft · Sistema de Partículas de Rotura
//
//  RESPONSABILIDADES:
//    • spawnParticles(scene, x, y, z, material)
//        Instancia 12–15 mini-cubos con velocidad y rotación
//        aleatorias, añadiéndolos a la escena y al array interno.
//
//    • updateParticles(dt, scene)
//        Avanza la simulación: gravedad, movimiento, rotación y
//        recolección de partículas muertas (lifespan o MIN_Y).
//
//  NOTAS DE DISEÑO:
//    • Los materiales de los bloques son compartidos (MATERIALS en
//      world.js ya los crea como singletons MeshLambertMaterial).
//      Las partículas usan el mismo material SIN clonarlo para
//      mantener el mismo aspecto visual sin coste extra de memoria.
//      Como consecuencia NO llames material.dispose() desde aquí.
//
//    • geometry.dispose() SÍ se llama en cada partícula al morir,
//      ya que cada instancia crea su propia BoxGeometry(0.2,0.2,0.2).
//
//  MATEMÁTICA DE SIMULACIÓN (integración de Euler explícita):
//    v_y(t+dt) = v_y(t) + GRAVITY × dt        ← aceleración constante
//    pos(t+dt) = pos(t) + v(t+dt) × dt        ← posición
//    rot(t+dt) = rot(t) + ω × dt              ← ángulo (radianes)
// ═══════════════════════════════════════════════════════════════

import * as THREE from 'three';

// ── Constantes de simulación ────────────────────────────────────
const GRAVITY = -20;   // m/s² (igual al CONFIG.GRAVITY del jugador × escala visual)
const MIN_Y   = -20;   // cota mínima antes de reclamar la partícula (world.js usa -20)

// ── Pool interno ─────────────────────────────────────────────────
//  Array mutable: las partículas se insertan al spawnear y se
//  eliminan al morir. La iteración se hace en orden inverso para
//  poder hacer splice() sin saltarse índices.
const particles = [];

// ── Geometría reutilizable por shape ─────────────────────────────
//  BoxGeometry(0.2, 0.2, 0.2) es suficientemente pequeña para
//  parecer "esquirlas" de bloque sin saturar el fill-rate.
const _SHARD_GEO = new THREE.BoxGeometry(0.2, 0.2, 0.2);

/**
 * Instancia entre 12 y 15 mini-cubos de "esquirla" alrededor de
 * la posición (x, y, z) del bloque roto.
 *
 * @param {THREE.Scene}    scene    — Escena Three.js activa
 * @param {number}         x        — Coordenada X (centro del bloque)
 * @param {number}         y        — Coordenada Y (centro del bloque)
 * @param {number}         z        — Coordenada Z (centro del bloque)
 * @param {THREE.Material} material — Material del bloque roto (compartido)
 */
export function spawnParticles(scene, x, y, z, material) {
  // Número aleatorio de partículas entre 12 y 15 inclusive
  const count = 12 + Math.floor(Math.random() * 4);

  for (let i = 0; i < count; i++) {
    // ── Geometría individual (se dispone al morir) ──────────────
    //  Usamos una BoxGeometry independiente por partícula para poder
    //  llamar geometry.dispose() al recogerla sin afectar a las demás.
    const geo  = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    const mesh = new THREE.Mesh(geo, material);

    // ── Posición: dispersión aleatoria dentro del cubo 1×1×1 ────
    mesh.position.set(
      x + (Math.random() - 0.5),
      y + (Math.random() - 0.5),
      z + (Math.random() - 0.5)
    );

    // ── Velocidad inicial ───────────────────────────────────────
    //  Ejes X/Z: distribución uniforme en [-3, +3] → expansión radial
    //  Eje Y:    distribución en [2, 7]  → sesgo ascendente (saltan)
    const velocity = new THREE.Vector3(
      (Math.random() - 0.5) * 6,
      2 + Math.random() * 5,
      (Math.random() - 0.5) * 6
    );

    // ── Velocidad angular (giro de la esquirla mientras vuela) ──
    //  Rango ±5 rad/s en cada eje → rotación caótica pero legible
    const angularVelocity = new THREE.Vector3(
      (Math.random() - 0.5) * 10,
      (Math.random() - 0.5) * 10,
      (Math.random() - 0.5) * 10
    );

    // ── Tiempo de vida entre 1.0 y 1.5 segundos ────────────────
    const lifespan = 1.0 + Math.random() * 0.5;

    scene.add(mesh);
    particles.push({ mesh, velocity, angularVelocity, lifespan });
  }
}

/**
 * Avanza la simulación de todas las partículas activas y recoge
 * las que han expirado o caído por debajo del suelo.
 *
 * Debe llamarse cada frame desde el bucle animate() de main.js.
 *
 * @param {number}      dt    — Delta time en segundos
 * @param {THREE.Scene} scene — Escena (para scene.remove)
 */
export function updateParticles(dt, scene) {
  // Iteración en ORDEN INVERSO: permite splice(i, 1) sin saltarse elementos
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];

    // ── 1. Gravedad: integración de Euler ──────────────────────
    p.velocity.y += GRAVITY * dt;

    // ── 2. Movimiento traslacional ──────────────────────────────
    p.mesh.position.x += p.velocity.x * dt;
    p.mesh.position.y += p.velocity.y * dt;
    p.mesh.position.z += p.velocity.z * dt;

    // ── 3. Rotación angular ─────────────────────────────────────
    p.mesh.rotation.x += p.angularVelocity.x * dt;
    p.mesh.rotation.y += p.angularVelocity.y * dt;
    p.mesh.rotation.z += p.angularVelocity.z * dt;

    // ── 4. Reducir tiempo de vida ───────────────────────────────
    p.lifespan -= dt;

    // ── 5. Recolección ──────────────────────────────────────────
    //  Condiciones de muerte:
    //    a) lifespan agotado (expiración natural)
    //    b) partícula por debajo del límite del mundo (MIN_Y)
    if (p.lifespan <= 0 || p.mesh.position.y < MIN_Y) {
      scene.remove(p.mesh);
      p.mesh.geometry.dispose();   // liberar la BoxGeometry individual
      // NO disponer el material: es compartido con el bloque en world.js
      particles.splice(i, 1);
    }
  }
}