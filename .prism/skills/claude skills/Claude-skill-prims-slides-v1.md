# Slide Templates Reference

Full pptxgenjs code blocks for each slide type in the Prism design system.
Copy and adapt — replace placeholder text with actual content.

---

## COVER SLIDE

```javascript
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  // Left vertical accent bar
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.55, y: 0.7, w: 0.04, h: 3.4,
    fill: { color: C.cyan }, line: { color: C.cyan },
  });

  monoLabel(s, "COMPANY / PRODUCT  ·  SEED ROUND  ·  2026", 0.72, 0.65, C.muted, 8);

  // Hero headline (highlighted first word)
  s.addText("Hero headline\nline two\nline three.", {
    x: 0.72, y: 1.0, w: 6.2, h: 3.2,
    fontSize: 52, fontFace: "Courier New",
    color: C.white, bold: true, align: "left",
    lineSpacingMultiple: 1.05, margin: 0,
  });

  // Highlight block behind first line
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.72, y: 1.0, w: 4.2, h: 0.78,
    fill: { color: C.cyan, transparency: 88 },
    line: { color: C.cyan, transparency: 80 },
  });

  // System spec card (right side)
  s.addShape(pres.shapes.RECTANGLE, {
    x: 7.2, y: 0.9, w: 2.5, h: 3.2,
    fill: { color: C.card }, line: { color: C.cardBord, width: 1 },
  });
  monoLabel(s, "SYSTEM SPEC", 7.35, 1.05, C.cyan, 7.5);

  const specs = [
    ["7",      "substrate cells"],
    ["6",      "consumers"],
    ["400+",   "tests passing"],
    ["$0.28",  "/MTok inference"],
    ["2m 42s", "audit runtime"],
  ];
  specs.forEach(([val, lbl], i) => {
    const y = 1.42 + i * 0.52;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 7.28, y, w: 2.32, h: 0.44,
      fill: { color: "161B22" }, line: { color: C.cardBord, width: 0.5 },
    });
    s.addText(val, { x: 7.35, y: y + 0.02, w: 1.0, h: 0.24, fontSize: 17, fontFace: "Courier New", color: C.cyan, bold: true, margin: 0 });
    s.addText(lbl, { x: 7.35, y: y + 0.22, w: 2.1, h: 0.18, fontSize: 8.5, fontFace: "Courier New", color: C.silver, margin: 0 });
  });

  // Footer bar
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 4.92, w: 10, h: 0.705,
    fill: { color: C.card }, line: { color: C.cardBord },
  });
  s.addText("Tagline — what it is not, and what it is.", {
    x: 0.55, y: 5.0, w: 7.5, h: 0.35,
    fontSize: 11, fontFace: "Courier New", color: C.silver, margin: 0,
  });
  s.addText("domain.com", {
    x: 8.3, y: 5.0, w: 1.4, h: 0.35,
    fontSize: 11, fontFace: "Courier New", color: C.cyan, bold: true, margin: 0,
  });
}
```

---

## PROBLEM SLIDE

```javascript
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  monoLabel(s, "SLIDE 02  ·  THE PROBLEM", 0.5, 0.22, C.muted, 7.5);

  s.addText("Main problem statement.", {
    x: 0.5, y: 0.52, w: 9, h: 1.1,
    fontSize: 28, fontFace: "Courier New", color: C.white, bold: true, margin: 0,
  });

  // Incident / evidence box (left, amber border)
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.5, y: 1.78, w: 5.6, h: 1.3,
    fill: { color: C.card }, line: { color: C.amber, width: 1.5 },
  });
  monoLabel(s, "REAL INCIDENT  ·  CONTEXT LABEL", 0.65, 1.88, C.amber, 7.5);
  s.addText("Evidence narrative. One to three sentences max.", {
    x: 0.65, y: 2.1, w: 5.3, h: 0.85,
    fontSize: 11, fontFace: "Courier New", color: C.silver, margin: 0, lineSpacingMultiple: 1.3,
  });

  // Gap taxonomy cards (right column)
  const gaps = [
    ["GAP TYPE 1", "Short description of what goes wrong", C.amber],
    ["GAP TYPE 2", "Short description of what goes wrong", C.amber],
    ["GAP TYPE 3", "Short description of what goes wrong", C.red],
    ["GAP TYPE 4", "Short description of what goes wrong", C.red],
  ];
  gaps.forEach(([title, desc, col], i) => {
    const y = 1.78 + i * 0.65;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 6.5, y, w: 3.2, h: 0.58,
      fill: { color: C.card }, line: { color: C.cardBord, width: 0.5 },
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x: 6.5, y, w: 0.05, h: 0.58,
      fill: { color: col }, line: { color: col },
    });
    s.addText(title, { x: 6.65, y: y + 0.06, w: 2.9, h: 0.22, fontSize: 8.5, fontFace: "Courier New", color: col, bold: true, margin: 0 });
    s.addText(desc,  { x: 6.65, y: y + 0.3,  w: 2.95, h: 0.22, fontSize: 8.5, fontFace: "Courier New", color: C.silver, margin: 0 });
  });

  // Secondary block (red border — the twist / escalation)
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.5, y: 3.42, w: 5.6, h: 0.88,
    fill: { color: C.card }, line: { color: C.red, width: 1.2 },
  });
  monoLabel(s, "SECONDARY BLOCK LABEL", 0.65, 3.52, C.red, 7.5);
  s.addText("The escalating consequence or second layer of the problem.", {
    x: 0.65, y: 3.7, w: 5.3, h: 0.52,
    fontSize: 8.5, fontFace: "Courier New", color: C.silver, margin: 0, lineSpacingMultiple: 1.3,
  });

  // Closing tagline
  s.addText("The principle this slide establishes.", {
    x: 0.5, y: 4.5, w: 9, h: 0.45,
    fontSize: 10.5, fontFace: "Courier New", color: C.cyan, bold: true, italic: true, margin: 0,
  });
}
```

---

## PRINCIPLE SLIDE (DON'T GUESS / VERIFY pattern)

```javascript
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  monoLabel(s, "SLIDE 04  ·  ARCHITECTURAL INSIGHT", 0.5, 0.22, C.muted, 7.5);

  s.addText("DON'T GUESS.", {
    x: 0.5, y: 0.7, w: 9, h: 1.1,
    fontSize: 58, fontFace: "Courier New", color: C.white, bold: true, align: "center", margin: 0,
  });
  s.addText("VERIFY.", {
    x: 0.5, y: 1.72, w: 9, h: 1.1,
    fontSize: 58, fontFace: "Courier New", color: C.cyan, bold: true, align: "center", margin: 0,
  });

  // Inverted stack diagram
  const stackItems = [
    { label: "LLM  →  thin interpreter",                          col: C.muted, bg: "161B22" },
    { label: "typecheck · lsp · run_tests · schema_inspect · ast_query", col: C.cyan,  bg: "0D1A15" },
  ];
  stackItems.forEach(({ label, col, bg }, i) => {
    const y = 3.2 + i * 0.62;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 1.5, y, w: 7, h: 0.5,
      fill: { color: bg }, line: { color: col, width: 0.8 },
    });
    s.addText(label, { x: 1.6, y: y + 0.1, w: 6.8, h: 0.3, fontSize: 10.5, fontFace: "Courier New", color: col, align: "center", margin: 0 });
  });

  monoLabel(s, "← INVERTED STACK  ·  THE SUBSTRATE IS THE BRAIN  ·  LLM IS A THIN INTERPRETER ON TOP", 0.8, 4.08, C.muted, 7.5);

  s.addText("Supporting sentence explaining the architectural implication.", {
    x: 0.5, y: 4.65, w: 9, h: 0.6,
    fontSize: 11.5, fontFace: "Courier New", color: C.silver, align: "center", margin: 0, lineSpacingMultiple: 1.3,
  });
}
```

---

## TIMING / WHY NOW SLIDE (Three forces)

```javascript
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  monoLabel(s, "SLIDE 03  ·  TIMING", 0.5, 0.22, C.muted, 7.5);

  s.addText("Declarative statement about the moment.", {
    x: 0.5, y: 0.52, w: 9, h: 1.5,
    fontSize: 34, fontFace: "Courier New", color: C.white, bold: true, margin: 0,
  });

  const forces = [
    { num: "01", title: "FORCE NAME", body: "2-3 sentence explanation.", col: C.cyan  },
    { num: "02", title: "FORCE NAME", body: "2-3 sentence explanation.", col: C.amber },
    { num: "03", title: "FORCE NAME", body: "2-3 sentence explanation.", col: C.red   },
  ];
  forces.forEach(({ num, title, body, col }, i) => {
    const x = 0.5 + i * 3.15;
    s.addShape(pres.shapes.RECTANGLE, {
      x, y: 2.35, w: 2.95, h: 2.55,
      fill: { color: C.card }, line: { color: C.cardBord, width: 0.8 },
    });
    s.addShape(pres.shapes.RECTANGLE, {
      x, y: 2.35, w: 2.95, h: 0.04,
      fill: { color: col }, line: { color: col },
    });
    s.addText(num,   { x: x + 0.15, y: 2.5,  w: 1,    h: 0.45, fontSize: 28, fontFace: "Courier New", color: col, bold: true, margin: 0 });
    s.addText(title, { x: x + 0.15, y: 3.02, w: 2.65, h: 0.25, fontSize: 9,  fontFace: "Courier New", color: col, bold: true, charSpacing: 2, margin: 0 });
    s.addText(body,  { x: x + 0.15, y: 3.32, w: 2.65, h: 1.4,  fontSize: 10, fontFace: "Courier New", color: C.silver, margin: 0, lineSpacingMultiple: 1.35 });
  });

  s.addText("Closing one-liner positioning the window of opportunity.", {
    x: 0.5, y: 4.95, w: 9, h: 0.35,
    fontSize: 11, fontFace: "Courier New", color: C.muted, italic: true, margin: 0,
  });
}
```

---

## PRODUCT / COMMAND GRID SLIDE

```javascript
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  monoLabel(s, "SLIDE 05  ·  THE PRODUCT", 0.5, 0.22, C.muted, 7.5);

  s.addText("Product positioning headline.", {
    x: 0.5, y: 0.48, w: 6.5, h: 1.5,
    fontSize: 22, fontFace: "Courier New", color: C.white, bold: true, margin: 0, lineSpacingMultiple: 1.15,
  });

  // Typical loop card (top right)
  s.addShape(pres.shapes.RECTANGLE, {
    x: 6.6, y: 0.48, w: 3.1, h: 1.44,
    fill: { color: C.card }, line: { color: C.cardBord, width: 0.8 },
  });
  monoLabel(s, "TYPICAL LOOP", 6.75, 0.58, C.cyan, 7.5);
  s.addText("Step A → Step B → Step C → Step D → Step E", {
    x: 6.75, y: 0.84, w: 2.82, h: 0.95,
    fontSize: 9, fontFace: "Courier New", color: C.silver, margin: 0, lineSpacingMultiple: 1.35,
  });

  // Consumer command cards (2-column grid)
  const commands = [
    { cmd: "/command1", desc: "What it does — one line",  col: C.cyan  },
    { cmd: "/command2", desc: "What it does — one line",  col: C.cyan  },
    { cmd: "/command3", desc: "What it does — one line",  col: C.amber },
    { cmd: "/command4", desc: "What it does — one line",  col: C.amber },
    { cmd: "/command5", desc: "What it does — one line",  col: C.amber },
    { cmd: "/command6", desc: "What it does — one line",  col: C.muted },
  ];
  commands.forEach(({ cmd, desc, col }, i) => {
    const col_i = i % 2;
    const row_i = Math.floor(i / 2);
    const x = 0.5 + col_i * 4.75;
    const y = 2.12 + row_i * 0.82;
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: 4.55, h: 0.68, fill: { color: C.card }, line: { color: C.cardBord, width: 0.5 } });
    s.addShape(pres.shapes.RECTANGLE, { x, y, w: 0.05, h: 0.68, fill: { color: col }, line: { color: col } });
    s.addText(cmd,  { x: x + 0.15, y: y + 0.07, w: 2.2,  h: 0.25, fontSize: 13, fontFace: "Courier New", color: col, bold: true, margin: 0 });
    s.addText(desc, { x: x + 0.15, y: y + 0.36, w: 4.25, h: 0.28, fontSize: 9,  fontFace: "Courier New", color: C.silver, margin: 0 });
  });

  s.addText("Footnote · Footnote · Footnote", {
    x: 0.5, y: 5.05, w: 9, h: 0.35,
    fontSize: 9.5, fontFace: "Courier New", color: C.muted, margin: 0,
  });
}
```

---

## CELL / SUBSTRATE GRID SLIDE

```javascript
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  monoLabel(s, "SLIDE 07  ·  DEFENSIBILITY", 0.5, 0.22, C.muted, 7.5);

  s.addText("Three-line\nhero statement\nhere.", {
    x: 0.5, y: 0.5, w: 5.5, h: 1.8,
    fontSize: 22, fontFace: "Courier New", color: C.white, bold: true, margin: 0, lineSpacingMultiple: 1.12,
  });

  // Moat callout (top right, amber)
  s.addShape(pres.shapes.RECTANGLE, {
    x: 6.2, y: 0.5, w: 3.5, h: 1.7,
    fill: { color: C.card }, line: { color: C.amber, width: 1.2 },
  });
  monoLabel(s, "THE MOAT", 6.38, 0.62, C.amber, 7.5);
  s.addText("2-3 sentence moat argument.", {
    x: 6.38, y: 0.9, w: 3.15, h: 1.1,
    fontSize: 9.5, fontFace: "Courier New", color: C.silver, margin: 0, lineSpacingMultiple: 1.3,
  });

  // Cell cards (2-column, last item centred)
  const cells = [
    { name: "cell_one",   note: "what it does" },
    { name: "cell_two",   note: "what it does" },
    { name: "cell_three", note: "what it does" },
    { name: "cell_four",  note: "what it does" },
    { name: "cell_five",  note: "what it does" },
    { name: "cell_six",   note: "what it does" },
    { name: "cell_seven", note: "what it does" }, // last item → full width centred
  ];
  cells.forEach(({ name, note }, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.5 + col * 4.7;
    const y = 2.2 + row * 0.72;
    if (i === cells.length - 1 && cells.length % 2 === 1) {
      const cx = 0.5;
      s.addShape(pres.shapes.RECTANGLE, { x: cx, y, w: 9.0, h: 0.58, fill: { color: C.card }, line: { color: C.cyan, width: 0.8 } });
      s.addText(name, { x: cx + 0.15, y: y + 0.05, w: 4, h: 0.24, fontSize: 11, fontFace: "Courier New", color: C.cyan, bold: true, margin: 0 });
      s.addText(note, { x: cx + 0.15, y: y + 0.3,  w: 8.7, h: 0.2, fontSize: 8.5, fontFace: "Courier New", color: C.silver, margin: 0 });
    } else {
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: 4.5, h: 0.58, fill: { color: C.card }, line: { color: C.cardBord, width: 0.5 } });
      s.addShape(pres.shapes.RECTANGLE, { x, y, w: 0.05, h: 0.58, fill: { color: C.cyan }, line: { color: C.cyan } });
      s.addText(name, { x: x + 0.15, y: y + 0.05, w: 2.5,  h: 0.24, fontSize: 11, fontFace: "Courier New", color: C.cyan, bold: true, margin: 0 });
      s.addText(note, { x: x + 0.15, y: y + 0.3,  w: 4.15, h: 0.2,  fontSize: 8.5, fontFace: "Courier New", color: C.silver, margin: 0 });
    }
  });

  s.addText("Closing defensive statement.", {
    x: 0.5, y: 5.12, w: 9, h: 0.3,
    fontSize: 9.5, fontFace: "Courier New", color: C.muted, italic: true, margin: 0,
  });
}
```

---

## MARKET + PRICING SLIDE

```javascript
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  monoLabel(s, "SLIDE 09  ·  MARKET + BUSINESS MODEL", 0.5, 0.22, C.muted, 7.5);

  s.addText("Every [target] is a candidate.", {
    x: 0.5, y: 0.5, w: 9, h: 1.3,
    fontSize: 32, fontFace: "Courier New", color: C.white, bold: true, margin: 0,
  });

  // Three stat callouts
  const stats = [
    { val: "20M+", lbl: "target users\ndoing X today" },
    { val: "↑ ∞",  lbl: "trend metric\nstill climbing"  },
    { val: "$0",   lbl: "credible alternative\nexists today" },
  ];
  stats.forEach(({ val, lbl }, i) => {
    const x = 0.5 + i * 3.15;
    s.addText(val, { x, y: 2.0, w: 2.8, h: 0.85, fontSize: 44, fontFace: "Courier New", color: C.cyan, bold: true, margin: 0 });
    s.addText(lbl, { x, y: 2.88, w: 2.8, h: 0.6,  fontSize: 9.5, fontFace: "Courier New", color: C.silver, margin: 0, lineSpacingMultiple: 1.3 });
  });

  // Pricing section divider
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0.5, y: 3.72, w: 9, h: 0.22,
    fill: { color: C.cardBord }, line: { color: C.cardBord },
  });
  monoLabel(s, "PRICING TIERS", 0.5, 3.72, C.muted, 7.5);

  // Tier cards (highlight middle)
  const tiers = [
    { tier: "Individual", price: "$15 / mo",        note: "Solo SKU",               col: C.muted, highlight: false },
    { tier: "Team",       price: "$50 / seat / mo", note: "Shared history + CI gate", col: C.cyan,  highlight: true  },
    { tier: "Enterprise", price: "Custom",           note: "Self-hosted + private routing", col: C.amber, highlight: false },
  ];
  tiers.forEach(({ tier, price, note, col, highlight }, i) => {
    const x = 0.5 + i * 3.15;
    s.addShape(pres.shapes.RECTANGLE, {
      x, y: 4.1, w: 2.95, h: 1.18,
      fill: { color: C.card }, line: { color: col, width: highlight ? 1.5 : 0.5 },
    });
    s.addText(tier,  { x: x + 0.15, y: 4.2,  w: 2.65, h: 0.28, fontSize: 11, fontFace: "Courier New", color: col, bold: true, margin: 0 });
    s.addText(price, { x: x + 0.15, y: 4.52, w: 2.65, h: 0.32, fontSize: 14, fontFace: "Courier New", color: C.white, bold: true, margin: 0 });
    s.addText(note,  { x: x + 0.15, y: 4.88, w: 2.65, h: 0.32, fontSize: 8.5, fontFace: "Courier New", color: C.silver, margin: 0 });
  });
}
```

---

## ASK / CLOSING SLIDE

```javascript
{
  const s = pres.addSlide();
  s.background = { color: C.bg };

  monoLabel(s, "SLIDE 11  ·  THE ASK", 0.5, 0.22, C.muted, 7.5);

  s.addText("Seed round.", {
    x: 0.5, y: 0.6, w: 9, h: 1.0,
    fontSize: 52, fontFace: "Courier New", color: C.white, bold: true, margin: 0,
  });
  s.addText("18 months. Team to N. Key outcome.", {
    x: 0.5, y: 1.6, w: 9, h: 0.6,
    fontSize: 18, fontFace: "Courier New", color: C.cyan, margin: 0,
  });

  // Milestone table
  const milestones = [
    ["Q3 2026", "Milestone headline",         "Supporting note"],
    ["Q4 2026", "Milestone headline",         "Supporting note"],
    ["Q1 2027", "Milestone headline",         "Supporting note"],
    ["Q2 2027", "Milestone headline",         "Supporting note"],
  ];
  milestones.forEach(([date, headline, note], i) => {
    const y = 2.42 + i * 0.68;
    s.addShape(pres.shapes.RECTANGLE, {
      x: 0.5, y, w: 9, h: 0.6,
      fill: { color: i % 2 === 0 ? C.card : "0D1118" }, line: { color: C.cardBord, width: 0.4 },
    });
    s.addText(date,     { x: 0.65, y: y + 0.12, w: 1.2, h: 0.32, fontSize: 10, fontFace: "Courier New", color: C.cyan, bold: true, margin: 0 });
    s.addText(headline, { x: 2.0,  y: y + 0.12, w: 3.8, h: 0.32, fontSize: 10, fontFace: "Courier New", color: C.white, bold: true, margin: 0 });
    s.addText(note,     { x: 5.9,  y: y + 0.12, w: 3.45, h: 0.32, fontSize: 9, fontFace: "Courier New", color: C.silver, margin: 0 });
  });

  // Footer bar
  s.addShape(pres.shapes.RECTANGLE, {
    x: 0, y: 4.95, w: 10, h: 0.675,
    fill: { color: C.card }, line: { color: C.cardBord },
  });
  s.addText("Product  ·  domain.com  ·  email@company.com", {
    x: 0.5, y: 5.05, w: 7, h: 0.35,
    fontSize: 10, fontFace: "Courier New", color: C.silver, margin: 0,
  });
  s.addText("TAGLINE. TAGLINE.", {
    x: 6.5, y: 5.05, w: 3.2, h: 0.35,
    fontSize: 10, fontFace: "Courier New", color: C.cyan, bold: true, align: "right", margin: 0,
  });
}
```