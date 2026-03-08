# 🎮 VibeCraft — Voxel Engine Alpha

**VibeCraft** es un motor de juego de tipo voxel construido desde cero utilizando **Three.js** y **WebGL**. El objetivo del proyecto es recrear la experiencia clásica de los juegos de construcción de bloques utilizando tecnologías web modernas, centrándose en la optimización extrema y la fidelidad estética "Vanilla".

> ⚡ **Nota del Proyecto:** Este motor es **100% vibecoded**. Cada línea de código, shader y lógica de arquitectura ha sido construida y refinada mediante pair-programming iterativo con IA, demostrando el potencial del desarrollo asistido moderno.

---

## 🛠️ Estado Actual (Fase: Alpha Avanzada)

Actualmente, el proyecto cuenta con un núcleo sólido de motor que ya incluye sistemas complejos de atmósfera, física, renderizado y persistencia de datos reales.

### 1. Persistencia y Gestión de Mundos (NUEVO)
* **Autoguardado Invisible**: Integración nativa con `IndexedDB` para guardar miles de bloques en el navegador de forma asíncrona sin impactar el rendimiento.
* **Archivos Físicos (`.vibecraft`)**: Capacidad de exportar mundos a archivos físicos para respaldos y compartirlos, así como importar mundos directamente al navegador.
* **Gestor de Mundos**: Interfaz dedicada para crear, cargar, gestionar y eliminar múltiples espacios de guardado.

### 2. Sistema de Atmósfera e Iluminación
* **Ciclo Día/Noche Dinámico**: Interpolación de colores en tiempo real para el cielo, la niebla y la iluminación ambiental basada en un reloj interno de 20 minutos.
* **Astros Celestiales**: El Sol y la Luna orbitan de forma asimétrica, siguiendo la posición del jugador para mantener una escala infinita.
* **Nubes Volumétricas Optimizadas**: Utiliza un sistema de **3x3 Grid Snapping** con `InstancedMesh` basado en un patrón de bits (`clouds.png`), lo que permite renderizar miles de nubes con una sola llamada de dibujo (Draw Call).

### 3. Motor de Física y Movimiento
* **Cámara en Primera Persona**: Controles `PointerLock` con jerarquía de Yaw/Pitch para evitar inclinaciones de horizonte indeseadas.
* **Colisiones AABB**: Detección de colisiones precisa contra bloques sólidos, permitiendo atravesar bloques no sólidos como antorchas.
* **Head Bobbing & Pausa Real**: Animación procedural de balanceo de cámara al caminar. Al presionar ESC, el bucle de físicas se congela por completo en un menú de pausa interactivo.

### 4. Mecánicas de Construcción
* **Raycasting de Precisión**: Sistema de selección de bloques con un wireframe dinámico que se adapta al tamaño del objeto (bloque estándar vs antorcha).
* **Iluminación Dinámica**: Las antorchas emiten luz real (`PointLight`), adaptan su rotación automáticamente al pegarse a las paredes y gestionan su memoria (`dispose`) al ser destruidas.

### 5. Interfaz de Usuario (UI)
* **Menú Principal**: Diseño fiel a Minecraft con un panorama orbital cinemático de fondo y tipografía pixelada.
* **Hotbar y HUD**: Barra de objetos con iconos generados por código (Canvas 2D) y visualización de coordenadas/velocidad en tiempo real.

---

## 🚀 Especificaciones Técnicas

| Componente | Tecnología / Técnica |
| :--- | :--- |
| **Core 3D** | Three.js r158 (ES Modules) |
| **Renderizado** | WebGLRenderer con PCFSoftShadowMap |
| **Base de Datos** | `IndexedDB` (Asíncrona) + API FileReader/Blob |
| **Optimización** | Compresión de strings para bloques, `InstancedMesh` para nubes y caché de mallas del mundo |
| **Estilos** | CSS Moderno con Stacking Contexts y selectores de estado |

---

## 🔮 Próximos Pasos (Roadmap)

* **Generación de Terreno Procedural**: *[EN PROGRESO]* Transición del mapa plano de 32x32 a un sistema de generación matemática utilizando **Ruido Perlin / Simplex** para crear colinas, valles y geografía natural.
* **Vegetación y Biomas**: Bloques de hojas con transparencia real y sistemas de generación de árboles procedurales.
* **Sistema de Chunks**: Optimización del mundo en sectores (ej. 16x16) para permitir mundos infinitos.
* **Multijugador**: Integración inicial de WebSockets para interactuar con otros jugadores en tiempo real.

---

**100% VibeCoded with ❤️ by Yisusmango & Claude.**