---
name: prism-slides
description: >
  Build polished, dark-terminal-aesthetic pitch deck slides in PPTX format using the Stellarum Prism design system.
  Use this skill whenever the user wants to create, update, or extend a slide deck — especially for investor pitches,
  product presentations, VC decks, or technical briefings. Triggers on: "make a deck", "build slides", "add a slide",
  "update slide", "new presentation", "pitch deck", "add these slides", "make this into a deck".
  Also use when the user pastes slide content and asks to "build it", "apply it", or "confirm" after reviewing changes.
  Always use this skill rather than describing slides in prose — actually produce the PPTX file.
---

# Prism Slides Skill

Produces professional PPTX decks in the Stellarum Prism design language: dark terminal aesthetic, monospaced type,
semantic colour-coded accents, and a structured card-grid layout system. Outputs are built with pptxgenjs and
rendered to PDF for QA before delivery.

---

## STEP 0 — Read the pptx skill first

Before writing any code, always read:
```
/mnt/skills/public/pptx/SKILL.md
```
This contains required environment setup and the soffice conversion command.

---

## STEP 1 — Understand what's needed

Extract from the conversation:
- **Full slide content** — headlines, body copy, stats, tables, bullet lists
- **Slide operation** — new deck / add slides / update specific slides
- **Slide count and order** — confirm before building if ambiguous
- **Any layout preferences** the user has stated

If updating an existing deck, always ask for the current `.js` source file or rebuild from
the latest `prism-deck.js` in `/home/claude/` if it exists in context.

---

## STEP 2 — Design System

### Palette
```javascript
const C = {
  bg:       "0A0C0F",   // near-black — slide background
  bgMid:    "111418",   // slightly lighter dark
  card:     "161B22",   // card surface
  cardBord: "1E2530",   // card border
  cyan:     "4DFFD2",   // PRIMARY accent — verified / clear / shipped
  amber:    "E8863A",   // SECONDARY accent — flagged / finding / in-flight
  red:      "FF4D6A",   // ERROR / warning / critical
  white:    "FFFFFF",   // headline type
  silver:   "C8D0DC",   // body copy
  muted:    "5A6478",   // de-emphasised / labels / footnotes
};
```

### Colour semantics — always apply consistently
| Colour | Meaning | Use for |
|--------|---------|---------|
| cyan   | Verified / clear / good | SHIPPED status, primary stats, key labels |
| amber  | Flagged / in-flight | IN FLIGHT / DESIGNED status, warnings, moat callouts |
| red    | Error / critical | Bug classes, "AND THEN THE TAB CLOSES" style blocks |
| muted  | De-emphasised | Sub-labels, footnotes, slide number labels, TARGET status |
| silver | Neutral body | Descriptive text inside cards |
| white  | Strong signal | Hero headlines |

### Typography
- **All type**: `Courier New` (monospace — non-negotiable for this design system)
- **Hero headlines**: 24–52px bold white
- **Section headers**: 8–9px muted, `charSpacing: 3` (spaced caps feel)
- **Card labels**: 9–11px accent colour, bold
- **Card body**: 8.5–10px silver
- **Footnotes**: 8.5–9.5px muted, italic

### Layout constants
- Slide size: 10" × 5.625" (16:9)
- Left margin: 0.5"
- Top eyebrow label: y=0.22
- Hero headline: y=0.48–0.7
- Card grid starts: y=1.75–2.2 (depends on headline height)
- Footer zone: y=4.9–5.2

---

## STEP 3 — Component Patterns

### Eyebrow label (every slide)
```javascript
function monoLabel(slide, text, x, y, color, size = 8.5) {
  slide.addText(text, {
    x, y, w: 9, h: 0.2,
    fontSize: size, fontFace: "Courier New",
    color, charSpacing: 3, margin: 0,
  });
}
monoLabel(s, "SLIDE 02  ·  THE PROBLEM", 0.5, 0.22, C.muted, 7.5);
```

### Card with left accent bar
```javascript
s.addShape(pres.shapes.RECTANGLE, {
  x, y, w: 4.55, h: 0.72,
  fill: { color: C.card }, line: { color: C.cardBord, width: 0.5 },
});
s.addShape(pres.shapes.RECTANGLE, {  // accent bar
  x, y, w: 0.05, h: 0.72,
  fill: { color: C.cyan }, line: { color: C.cyan },
});
s.addText(label, { x: x + 0.2, y: y + 0.1, ... color: C.cyan, bold: true });
s.addText(desc,  { x: x + 0.2, y: y + 0.42, ... color: C.silver });
```

### Two-column card grid (most common layout)
- 2 columns × N rows
- Column 1: x=0.5, Column 2: x=5.25
- Card width: 4.55", height: 0.68–0.82"
- Row spacing: 0.72–0.82" (tighten if >4 rows)
- Last odd item: full-width centred

### Stat callout (big number + small label below)
```javascript
s.addText(val, { fontSize: 17–44, color: C.cyan, bold: true });  // big value
s.addText(lbl, { fontSize: 8.5,   color: C.silver });            // label below
```

### Roadmap / table rows (alternating bg)
```javascript
rows.forEach(([col1, col2, col3, statusColor], i) => {
  s.addShape(..., { fill: { color: i % 2 === 0 ? C.card : "0D1118" } });
  // status label pushed right: align: "right"
});
```

### Status chips for roadmap
- `SHIPPED`  → `C.cyan`
- `IN FLIGHT` → `C.amber`
- `DESIGNED`  → `C.muted`
- `TARGET`    → `C.amber`

### Callout box (incident / moat / warning)
```javascript
s.addShape(pres.shapes.RECTANGLE, {
  x: 0.5, y: 2.18, w: 5.6, h: 1.3,
  fill: { color: C.card }, line: { color: C.amber, width: 1.5 },
});
monoLabel(s, "LABEL TEXT", 0.65, 2.28, C.amber, 7.5);
s.addText("body...", { x: 0.65, y: 2.56, ... color: C.silver });
```

### Footer bar (cover + ask slides)
```javascript
s.addShape(pres.shapes.RECTANGLE, {
  x: 0, y: 4.92, w: 10, h: 0.705,
  fill: { color: C.card }, line: { color: C.cardBord },
});
```

---

## STEP 4 — Slide Templates

Read `/mnt/skills/prism-slides/references/slide-templates.md` for full code templates for:
- Cover slide
- Problem slide (with incident box + gap cards + new block)
- Principle slide (DON'T GUESS / VERIFY)
- Product slide (consumer command grid + typical loop)
- IDE Surface slide (feature card grid)
- Substrate / Defensibility slide (cell grid + moat callout)
- Workspace Spine slide (directory tree + bullet list)
- Market + Pricing slide (big stats + tier table)
- Traction + Trajectory slide (shipped list + roadmap table)
- Ask / Closing slide (milestone table + footer)

---

## STEP 5 — Build Process

### Boilerplate
```javascript
const pptxgen = require("pptxgenjs");
async function main() {
  const pres = new pptxgen();
  pres.layout = "LAYOUT_16x9";

  // ... slides ...

  await pres.writeFile({ fileName: "/home/claude/deck.pptx" });
  console.log("Done.");
}
main().catch(console.error);
```

### Critical rules
1. **Never use literal newlines inside `addText` strings** — always use `\\n`
2. **Always wrap in `async function main()`** — top-level await causes errors
3. **All `addShape` before `addText`** on the same region (shapes are backgrounds)
4. **Test font sizes** — Courier New is wider than proportional fonts; reduce by ~15% vs design intent
5. **Card text overflow** — if headline + cards fight for space, reduce headline fontSize first (never clip cards)

### QA loop
```bash
node deck.js
python /mnt/skills/public/pptx/scripts/office/soffice.py --headless --convert-to pdf deck.pptx
pdftoppm -jpeg -r 150 deck.pdf slide
# view each slide-NN.jpg before delivering
```

Check every slide for:
- [ ] No text overflow or clipping
- [ ] No elements overlapping unintentionally  
- [ ] Colour semantics correct (cyan=good, amber=flagged, red=error)
- [ ] Footnotes and eyebrow labels visible and not clipped
- [ ] Footer bar on cover and ask slides

### Delivery
```bash
cp /home/claude/deck.pptx /mnt/user-data/outputs/deck.pptx
```
Then call `present_files`.

---

## STEP 6 — Iterative Updates

When the user provides updated slide content:
1. **Compare carefully** — state exactly what changed before touching any code
2. **Get confirmation** before applying
3. **Use Python `str_replace`** via subprocess for surgical edits — never rewrite the whole file unless adding a new slide
4. **Rebuild and QA** after every change — even small ones
5. **Renumber** eyebrow labels and JS comments when inserting/removing slides
6. **Revert cleanly** if a layout regresses — keep the working version in memory

### Inserting a new slide
- Insert the new slide block at the correct position in the JS
- Renumber all subsequent `monoLabel(s, "SLIDE NN ·..."` calls
- Rebuild and QA all affected slides, not just the new one

---

## Common Pitfalls

| Problem | Fix |
|---------|-----|
| Headline overflows into cards | Reduce fontSize by 4–6pt |
| Right column cards clipped | Reduce x offset or card width |
| Roadmap rows overflow bottom | Reduce row `y` start and/or row spacing |
| Literal newline in string | Replace with `\\n` |
| `require()` + top-level `await` | Wrap everything in `async function main()` |
| Text too wide for card | Reduce fontSize or split into two lines |
| Status labels truncated | Ensure `align: "right"` and sufficient `w` |