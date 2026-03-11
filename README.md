# 🎮 VibeCraft — Voxel Engine Beta

**VibeCraft** es un motor de juego de tipo voxel de alto rendimiento construido desde cero utilizando **Three.js** y **WebGL**. Este proyecto ha evolucionado de un prototipo estático a un motor de mundo infinito procedural, centrándose en la optimización de memoria (Garbage Collection) y la fidelidad técnica de un motor "Vanilla" moderno.

> ⚡ **Nota del Proyecto:** Este motor es **100% vibecoded**. Cada sistema de optimización, desde el frustum culling hasta el throttling de chunks, ha sido refinado mediante pair-programming iterativo con IA.

---

## 🛠️ Estado Actual (Fase: Beta Técnica / Pre-Multiplayer)

El motor ha superado la barrera del mundo finito. Ahora cuenta con una arquitectura de streaming de datos que permite la exploración infinita a 60 FPS estables.

### 1. Arquitectura de Mundo Infinito (NUEVO)
* **Streaming por Chunks (16x16x64)**: El mundo se divide en sectores gestionados de forma radial. Solo se procesa lo que el jugador tiene cerca, permitiendo una escala técnicamente infinita.
* **Chunk-Level Meshing**: A diferencia de la fase Alpha, cada chunk tiene su propia `InstancedMesh`. Esto reduce el coste de reconstrucción de O(N global) a O(1 local), eliminando los microcortes al construir o destruir bloques.
* **Generación Procedural Simplex**: Terreno generado mediante **Fractal Brownian Motion (FBM)** de 3 octavas, creando montañas, valles y llanuras orgánicas en tiempo real.

### 2. Ecosistema y Vegetación
* **Árboles Procedurales**: Sistema de generación de árboles con troncos de madera (`wood`) y copas de hojas (`leaves`) con siluetas octogonales e irregularidad aleatoria para evitar el aspecto cúbico perfecto.
* **Leaf Decay (Descomposición de Hojas)**: Algoritmo de muestreo aleatorio (20 ticks/frame) que detecta hojas "huérfanas" tras la tala y las desintegra gradualmente sin impactar el rendimiento.

### 3. Atmósfera e Iluminación Dinámica
* **Sombras Proyectadas Reales**: Sistema de sombras dinámicas que rotan en tiempo real siguiendo la posición exacta del Sol y la Luna.
* **Burbuja de Sombras (Shadow Mapping)**: La cámara de sombras y la luz direccional están ancladas al jugador, permitiendo sombras nítidas de alta resolución en un mundo infinito.
* **Ciclo de 20 Minutos**: Transiciones suaves entre el alba, mediodía, atardecer y una noche azulada totalmente jugable con iluminación ambiental reforzada.

### 4. Optimización de Memoria (Senior Tech)
* **Zero-Allocation Hot Path**: Uso de vectores y matrices globales reutilizables (`_worldPos`, `_matrix`, etc.) para evitar inundar el Recolector de Basura (GC) durante el bucle de renderizado.
* **Throttling de Generación**: Sistema que limita la creación a 1 chunk por frame para garantizar una latencia de entrada (Input Lag) mínima durante la exploración rápida.

---

## 🚀 Especificaciones Técnicas

| Componente | Tecnología / Técnica |
| :--- | :--- |
| **Core 3D** | Three.js r158 (ES Modules) |
| **Arquitectura** | Chunk-Based Rendering (Radial Loading) |
| **Físicas** | AABB Collision + Head Bobbing Procedural |
| **Persistencia** | `IndexedDB` con serialización por coordenadas |
| **Iluminación** | Dynamic Directional Light + Shadow Maps centrados |

---

## 🔮 Próximos Pasos (Roadmap)

* **🌐 Motor Multijugador (Fase actual)**: Implementación de servidor Node.js + Socket.io para sincronización de jugadores y eventos de bloques en tiempo real.
* **💧 Sistema de Fluidos**: Introducción de agua con físicas de propagación lateral y transparencia real.
* **🍃 Transparencia de Follaje**: Refinar el material de las hojas para permitir visibilidad a través de la red de píxeles (Alpha Hashing/Testing).
* **🔊 Sistema de Audio**: Sonidos espaciales para pasos, colocación de bloques y ambiente natural.

---

**100% VibeCoded with ❤️ by Yisusmango & Claude.**