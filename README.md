# 🎮 VibeCraft — Voxel Engine Beta

**VibeCraft** es un motor de juego de tipo voxel de alto rendimiento construido desde cero utilizando **Three.js** y **WebGL**. Este proyecto ha evolucionado de un prototipo estático a un motor de mundo infinito procedural y multijugador, centrándose en la optimización de memoria (Garbage Collection) y la fidelidad técnica de un motor "Vanilla" moderno.

> ⚡ **Nota del Proyecto:** Este motor es **100% vibecoded**. Cada sistema de optimización, desde el frustum culling hasta los autómatas celulares de los fluidos, ha sido refinado mediante pair-programming iterativo con IA.

---

## 🛠️ Estado Actual (Fase: Beta Multijugador)

El motor ha superado la barrera del mundo finito y de un solo jugador. Ahora cuenta con una arquitectura robusta que soporta exploración infinita, físicas de fluidos y sincronización en red a 60 FPS estables.

### 1. Arquitectura de Mundo Infinito
* **Streaming por Chunks (16x16x64)**: El mundo se divide en sectores gestionados de forma radial. Solo se procesa lo que el jugador tiene cerca, permitiendo una escala técnicamente infinita.
* **Chunk-Level Meshing**: A diferencia de la fase Alpha, cada chunk tiene su propia `InstancedMesh`. Esto reduce el coste de reconstrucción de O(N global) a O(1 local), eliminando los microcortes al construir o destruir bloques.
* **Generación Procedural Simplex**: Terreno generado mediante **Fractal Brownian Motion (FBM)** de 3 octavas, creando montañas, valles y llanuras orgánicas en tiempo real.

### 2. Motor Multijugador (NUEVO)
* **Sincronización en Tiempo Real**: Arquitectura Cliente-Servidor usando Node.js y Socket.io para sincronizar posiciones, rotaciones y eventos de bloques.
* **Sincronización de Inventario Remoto**: Los clones en el servidor muestran visualmente el bloque exacto que el jugador remoto tiene seleccionado en su mano.

### 3. Físicas de Fluidos Avanzadas (NUEVO)
* **Autómatas Celulares**: Sistema de agua dinámico evaluado por "Ticks" (5Hz) independiente de los FPS.
* **Propagación y Retracción**: El agua responde a la gravedad, se expande horizontalmente desgastando su nivel de fuerza, y se seca automáticamente si el bloque "fuente" es destruido.
* **Alturas Dinámicas (Slopes)**: Escalamiento geométrico en el eje Y dependiendo de la distancia a la fuente para simular corrientes fluidas reales.

### 4. Sistemas de Interfaz y Audio (NUEVO)
* **Inventario Creativo Dinámico**: Panel de 36 slots (27 inventario + 9 hotbar) con renderizado 3D de bloques, mecánica de "Click-to-hold" y sistema de borrado de ítems (Trash).
* **Audio Espacial WebAudio API**: Sistema de sonido posicional conectado a la cámara. Incluye acumulación de distancia para pasos precisos y modulación aleatoria de pitch (anti-machine-gun) para mayor realismo inmersivo.

### 5. Atmósfera, Ecosistema y Memoria
* **Transparencia Real**: Manejo avanzado de materiales para hojas y fluidos desactivando el `depthWrite` y usando Alpha Testing para eliminar el Z-fighting.
* **Ciclo de 20 Minutos**: Transiciones suaves entre el alba, mediodía, atardecer y una noche azulada totalmente jugable con iluminación dinámica (Sombras Proyectadas).
* **Zero-Allocation Hot Path**: Uso de vectores globales reutilizables para evitar inundar el Recolector de Basura (GC) durante el bucle de renderizado.

---

## 🚀 Especificaciones Técnicas

| Componente | Tecnología / Técnica |
| :--- | :--- |
| **Core 3D** | Three.js r158 (ES Modules) |
| **Arquitectura** | Chunk-Based Rendering (Radial Loading) |
| **Multijugador** | Node.js + Socket.io |
| **Físicas** | AABB Collision + Cellular Automata (Fluids) |
| **Persistencia** | `IndexedDB` con serialización por coordenadas |
| **Audio** | WebAudio API (Spatial + Detune) |

---

## 🔮 Próximos Pasos (Roadmap)

* **🦾 Animación de Personajes**: Implementar el "Arm Swing" (movimiento de brazo) al picar/colocar bloques, tanto en primera persona como en los modelos multijugador.
* **🕳️ Generación de Cuevas y Minerales**: Añadir ruido 3D (Perlin/Simplex) bajo tierra para generar sistemas de cavernas interconectadas y vetas de materiales.
* **💡 Iluminación Voxel (Light Propagation)**: Transición de la luz direccional global a un sistema de propagación de luz por bloques (antorchas que iluminan cuevas, sombras interiores).
* **❤️ Modo Supervivencia**: Integrar sistema de salud, daño por caída/ahogamiento y recolección real de recursos.

---

**100% VibeCoded with ❤️ by Yisusmango & Claude.**