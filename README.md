# Deep Canvas

Fast, offline **infinite canvas** for sketching, whiteboarding, and motion-style doodles.  
Privacy-first desktop app — no accounts, no cloud, everything saved locally.

https://github.com/ZENTCH-Q/Deep-Canvas.git

![demo](docs/demo.gif) <!-- add a short screen recording later -->

---

## ✨ Features

- **Blazing renderer** — spatial index + LOD simplification keeps big drawings smooth
- **Infinite pan & zoom** — zoom around cursor, buttery panning
- **Brushes** — pen, marker, glow, dashed; eraser
- **Shapes** — line, rectangle, ellipse; optional fill
- **Selection HUD** — resize/rotate handles, live style/animation layers
- **Style / Anim layers** — width, opacity, glow, hue, dash; spin, sway, pulse, bounce, orbit, shake
- **Gallery as landing** — create “+”, **rename** (double-click title), **delete**, **thumbnails from last view**
- **Autosave + history** — undo/redo stack, background autosave
- **Export** — save current viewport to PNG
- **Offline** — zero telemetry, runs locally

---

## 🚀 Install

### Windows (recommended)
Grab the latest `Deep Canvas x.y.z.exe` from **Releases** and install.  
If SmartScreen warns, click **More info → Run anyway** (unsigned builds).

## 🧭 Quick start & hotkeys

- **Tools:** Draw, Paint (bucket), Erase, Delete, Pan, Line/Rect/Ellipse, Select
- **Pan:** hold **Space**, drag
- **Zoom:** mouse wheel / trackpad (zooms around cursor)
- **Undo / Redo:** `Ctrl/⌘ + Z`, `Ctrl+Y` or `Shift+⌘ + Z`
- **Right-click** on canvas: context menu (Reset View, Save PNG, Delete Selected)
- **Gallery:**
  - Click **+** to create
  - **Double-click** card image to open canvas
  - **Double-click** title to rename
  - **⋯** menu → **Delete**
  - Thumbnails show the **last camera view** you left the canvas in

---

## 🛠️ Build from source

**Prereqs:** Node 18+ (or 20+)

```bash
# clone
git clone https://github.com/<you>/<repo>.git
cd deep-canvas

# dev
npm install
npm run dev
