# PreBase Motion & Interaction System Specification

## 1. Principles of Motion
Every animation in PreBase exists to communicate structural context and state transitions, not to ornament or distract.
- **Directional & Purposeful**: Informs where the user came from and where they arrived.
- **Interruptible**: Any gesture, click, or tab switch immediately cancels running tweens without lag or state corruption.
- **Performant & Native**: High-frequency graph operations run in the canvas RAF loop. Shell transitions leverage GPU-accelerated CSS `transform` and `opacity`.
- **Accessibility First**: Respects `prefers-reduced-motion` across all viewports and transitions.

---

## 2. Motion Timing & Easing Catalog

| Category | Target Timing | Easing Function | Application |
|---|---|---|---|
| Micro-interaction | 100–140 ms | `cubic-bezier(0.2, 0, 0, 1)` | Hover highlights, button presses, badge tags |
| Search Dropdown | 160–200 ms | `cubic-bezier(0.16, 1, 0.3, 1)` | Search result appearance, filter pills |
| Panel Transitions | 240–300 ms | `cubic-bezier(0.16, 1, 0.3, 1)` | Inspector slide/collapse, sidebar collapse |
| 3D Orb Inertia | 250–400 ms | Exponential decay damping | Drag release inertia with direct interruptibility |
| 3D Camera Focus | 350–450 ms | `cubic-bezier(0.16, 1, 0.3, 1)` | Explicit Reveal / Reset View camera interpolation |
| 3D ↔ 2D Mode Switch | 300–400 ms | `cubic-bezier(0.16, 1, 0.3, 1)` | Spatial crossfade and focused node stabilization |
| Theme Transition | 250–350 ms | `ease` | Uniform surface and text adaptation |

---

## 3. 3D ↔ 2D Mode Switching Orchestration
When transitioning between **3D Overview** and **2D Relationships**:

```
[3D Overview] 
     │
     ▼ (User clicks "Explore in 2D" or presses 'V')
[Phase A: Anchor Selection]
  - Target node highlighted with teal pulse halo
  - Unrelated 3D elements subtly drop opacity to 0.4
     │
     ▼ (100ms)
[Phase B: Crossfade & Spatial Re-anchoring]
  - 3D Canvas fades out (opacity: 1 -> 0, transform scale: 1 -> 0.96)
  - 2D Canvas fades in (opacity: 0 -> 1, transform scale: 1.04 -> 1)
  - Pointer events strictly disabled on departing layer
     │
     ▼ (250ms)
[Phase C: Relationship Expansion]
  - Central focus node stabilizes at viewport center
  - Direct dependencies & dependents fan out into column tiers
     │
     ▼
[Phase D: Interactive Ready]
  - 2D HUD and controls fully active
```

Returning to 3D runs the reverse sequence, perfectly restoring the user's previous 3D yaw, pitch, pan, and zoom without camera disorientation.

---

## 4. Reduced Motion (`prefers-reduced-motion`)
When the OS prefers reduced motion:
- Inertial physics are disabled (immediate stop on pointer up).
- 3D ↔ 2D transitions become instantaneous or simple 100ms linear opacity fades without scaling.
- Idle animations (pulse, spin) are halted.
- Camera moves jump directly to the target coordinates without interpolation.

