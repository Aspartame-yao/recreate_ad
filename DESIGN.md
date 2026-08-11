# DESIGN.md — 他山之石 · 全链路广告成片工具

Design system of record. Read by `impeccable detect` to separate intentional
system from drift. Product lane: **product** (app UI / workflow tool).

## Voice & register

Editorial-technical. Mono labels for machine metadata, a characterful grotesque
for headings, a clean geometric sans for body. Quiet surfaces, thin rules,
one cobalt accent. No gradients, no glassmorphism, no icon-tile-above-heading.

## Typography

Distinctive faces, deliberately off the AI-slop monoculture
(no Inter, Roboto, Space Grotesk, Geist, Plus Jakarta Sans, Fraunces).

| Role    | Family              | Fallback                          |
|---------|---------------------|-----------------------------------|
| display | Bricolage Grotesque | PingFang SC, sans-serif           |
| body    | Sora                | PingFang SC, Noto Sans SC, sans   |
| mono    | Spline Sans Mono    | SF Mono, monospace                |

### Type ramp (documented steps, px)

Micro/label tier and body tier are intentionally granular for a dense tool UI:

`9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 17, 18, 20, 22, 26, 32, 40`

- 9–11.5 — mono metadata, tags, tick labels
- 12–15 — body, controls, list rows
- 16–20 — section titles, modal titles
- 22–40 — stage titles, display numerals

### Weights

- display: 400 / 500 / 600 / 700
- body: 400 / 500 / 600
- mono: 400 / 500 / 600

## Color

Perceptual palette in OKLCH, theme **Cobalt**. All literals below are the
intentional system (paper/ink neutrals, one cobalt accent, semantic ok/warn/err,
graphite dark surfaces). Alpha variants of these hues are in-system.

### Neutrals (paper / ink / rule)

- paper `oklch(98.5% 0.004 250)` · paper-2 `oklch(96.8% 0.005 250)`
- ink `oklch(24% 0.02 258)` · ink-2 `oklch(34% 0.018 257)` · ink-3 `oklch(56% 0.015 257)`
- rule `oklch(90% 0.008 255)` · rule-2 `oklch(82% 0.01 255)`

### Accent (cobalt)

- accent `oklch(58% 0.20 256)` · accent-hover `oklch(52% 0.20 256)`
- accent-soft `oklch(94% 0.04 256)` · accent-ink `oklch(99% 0.005 250)`
- accent-2 (info, toast undo) `oklch(78% 0.14 200)`

### Dark surfaces (code / editor screen / toast)

- graphite `oklch(22% 0.016 260)` · graphite-2 `oklch(28% 0.018 260)`
- editor/preview scrim, playhead knobs, clip thumbs derive from graphite + alpha

### Semantic

- ok `oklch(64% 0.15 150)` · warn `oklch(72% 0.15 75)` · err `oklch(62% 0.17 25)`
- traffic-light dots (code card): r/y/g variants of err/warn/ok

Any hex that appears in the build is a compiled OKLCH-with-alpha of one of the
hues above (cobalt 256, ink 258, ok 150, warn 75, err 25, info 200). Colors
outside these hue families are drift and must be justified.

## Rounded scale

`--r-hair: 2px` · `--r-btn: 6px` · `--r-card: 10px` · `--r-pill: 999px`

Also in system: 3–8px small chip/tag/menu radii derived between hair and card.
Pill toggles use `--r-pill`. Nothing rounds at arbitrary off-scale values.

## Motion

Three named easings, never the browser default:

- `--ease-out cubic-bezier(.22,.61,.36,1)`
- `--ease-in cubic-bezier(.55,.06,.68,.19)`
- `--ease-in-out cubic-bezier(.65,.05,.36,1)`

Durations: `--dur-1 120ms · --dur-2 180ms · --dur-3 240ms · --dur-4 360ms`.
Progress fills animate via `transform: scaleX` (GPU), never `width`.
Respects `prefers-reduced-motion`.

## Anti-references (never reintroduce)

- Inter / Space Grotesk / Geist / Fraunces as primary faces
- purple→blue gradients, glassmorphism, neon glows
- cards nested in cards; single thick colored side-border "tabs"
- rounded-square icon tile stacked above every heading
