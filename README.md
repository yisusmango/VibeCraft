# 🎮 VibeCraft — Voxel Engine Alpha

**VibeCraft** es un motor de juego de tipo voxel construido desde cero utilizando **Three.js** y **WebGL**. El objetivo del proyecto es recrear la experiencia clásica de los juegos de construcción de bloques utilizando tecnologías web modernas, centrándose en la optimización extrema y la fidelidad estética "Vanilla".

## 🌟 La Visión del Proyecto

VibeCraft busca ser más que un clon; es una demostración técnica de cómo manejar miles de geometrías en tiempo real dentro del navegador. La arquitectura está diseñada de forma modular para permitir futuras expansiones como el guardado de mundos y el modo multijugador.

---

## 🛠️ Estado Actual (Fase: Alpha Avanzada)

Actualmente, el proyecto cuenta con un núcleo sólido de motor que ya incluye sistemas complejos de atmósfera, física y renderizado.

### 1. Sistema de Atmósfera e Iluminación
* **Ciclo Día/Noche Dinámico**: Interpolación de colores en tiempo real para el cielo, la niebla y la iluminación ambiental basada en un reloj interno de 20 minutos.
* **Astros Celestiales**: El Sol y la Luna orbitan de forma asimétrica, siguiendo la posición del jugador para mantener una escala infinita.
* **Nubes Volumétricas Optimizadas**: Utiliza un sistema de **3x3 Grid Snapping** con `InstancedMesh` basado en un patrón de bits (`clouds.png`), lo que permite renderizar miles de nubes con una sola llamada de dibujo (Draw Call).

### 2. Motor de Física y Movimiento
* **Cámara en Primera Persona**: Controles `PointerLock` con jerarquía de Yaw/Pitch para evitar inclinaciones de horizonte indeseadas.
* **Colisiones AABB**: Detección de colisiones precisa contra bloques sólidos, permitiendo atravesar bloques no sólidos como antorchas.
* **Head Bobbing**: Animación procedural de balanceo de cámara al caminar para aumentar la inmersión.

### 3. Mecánicas de Construcción
* **Raycasting de Precisión**: Sistema de selección de bloques con un wireframe dinámico que se adapta al tamaño del objeto (bloque vs antorcha).
* **Iluminación Dinámica**: Las antorchas emiten luz real (`PointLight`) y gestionan su memoria (`dispose`) al ser destruidas para evitar caídas de rendimiento.
* **Lógica de Orientación**: Las antorchas se inclinan automáticamente al colocarlas en paredes, detectando la normal de la cara del bloque apuntado.

### 4. Interfaz de Usuario (UI)
* **Menú Principal**: Diseño fiel a Minecraft con un panorama orbital cinemático de fondo y tipografía pixelada.
* **Hotbar y HUD**: Barra de objetos con iconos generados por código (Canvas 2D) y visualización de coordenadas/velocidad en tiempo real.
* **Dev Tools**: Panel integrado para manipular el tiempo del mundo de forma instantánea.

---

## 🚀 Especificaciones Técnicas

| Componente | Tecnología / Técnica |
| :--- | :--- |
| **Core** | Three.js r158 (ES Modules) |
| **Renderizado** | WebGLRenderer con PCFSoftShadowMap |
| **Optimización** | `InstancedMesh` para nubes y caché de mallas del mundo |
| **Estilos** | CSS Moderno con Stacking Contexts y animaciones de escala |

---

## 🔮 Próximos Pasos (Roadmap)
* **Persistencia**: Implementación de `localStorage` para el guardado automático de las construcciones.
* **Vegetación**: Bloques de hojas con transparencia y sistemas de árboles procedurales.
* **Generación de Terreno**: Transición de un mapa plano de 32x32 a un sistema de generación por ruido Perlin.
* **Multiplayer**: Integración inicial de WebSockets para ver a otros jugadores.

---

**VibeCoded with ❤️ by Yisusmango & Claude.**