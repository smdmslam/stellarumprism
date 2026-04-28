Yes — there is a **standard fix**, and it usually is not “write custom wrapping logic.” In xterm.js, arbitrary word cutoffs almost always come from a terminal-size mismatch, bad resize timing, or font/cell measurement issues rather than missing wrap code. [stackoverflow](https://stackoverflow.com/questions/13131162/line-wrapping-issues-in-xterm)

## Main cause

The most common cause is that xterm.js has one column width, while your backend PTY still thinks it has another, so wrapping happens at the wrong cell boundary. xterm.js maintainers explicitly call out that `fitAddon.fit()` only sizes the frontend and that you must also send the new `cols` and `rows` to the underlying PTY or shell process. [stackoverflow](https://stackoverflow.com/questions/13131162/line-wrapping-issues-in-xterm)

That means in a Tauri app, after every real resize, you generally need both:
- `fitAddon.fit()` or `term.resize(cols, rows)` on the frontend, and
- a PTY/window-size update on the backend side. [stackoverflow](https://stackoverflow.com/questions/13131162/line-wrapping-issues-in-xterm)

## What to check

If the text is wrapping in the middle of words like “should” becoming “shoul” + “d”, first verify that your backend PTY receives the updated dimensions after the terminal container changes size. xterm.js’s own FAQ/discussion says this exact symptom is usually caused by PTY size not matching terminal size. [stackoverflow](https://stackoverflow.com/questions/13131162/line-wrapping-issues-in-xterm)

Also check font rendering options, because xterm.js exposes `fontFamily`, `fontSize`, `letterSpacing`, and `lineHeight`, and aggressive values there can make cell measurement drift or clip glyphs. xterm.js documents `letterSpacing` as whole-pixel spacing and `lineHeight` as the rendered line height, so non-default values are worth testing back at defaults. [github](https://github.com/xtermjs/xterm.js/issues/2752)

## Standard setup

A typical stable setup is:
- Use the FitAddon.
- Open the terminal only after the container has a real size.
- On resize, call `fitAddon.fit()`.
- Read the resulting `term.cols` and `term.rows`.
- Send those exact values to the PTY backend. [stackoverflow](https://stackoverflow.com/questions/13131162/line-wrapping-issues-in-xterm)

Also avoid resizing continuously during drag if your layout is unstable, because one maintainer note says it is often better to wait until drag/resize settles before applying the resize. [stackoverflow](https://stackoverflow.com/questions/13131162/line-wrapping-issues-in-xterm)

## Practical fix

In practice, the fix is usually something like this:

```ts
const term = new Terminal({
  fontFamily: 'Menlo, Monaco, "Courier New", monospace',
  fontSize: 14,
  lineHeight: 1.0,
  letterSpacing: 0,
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);
term.open(container);

function syncSize() {
  fitAddon.fit();
  invoke('resize_pty', {
    cols: term.cols,
    rows: term.rows,
  });
}

new ResizeObserver(() => {
  requestAnimationFrame(syncSize);
}).observe(container);
```

The important part is not the observer itself; it is that the PTY gets resized to the same dimensions the frontend is using. That is the standard integration pattern described by xterm.js maintainers. [stackoverflow](https://stackoverflow.com/questions/13131162/line-wrapping-issues-in-xterm)

## Less common issues

If PTY sync is already correct, the next likely issue is font/canvas measurement. xterm.js has documented options around `fontFamily`, `fontSize`, `letterSpacing`, `lineHeight`, `customGlyphs`, and `rescaleOverlappingGlyphs`, which means rendering can vary by font and browser. [github](https://github.com/xtermjs/xterm.js/issues/2752)

So test these in order:
- Use a known-good monospace font.
- Set `letterSpacing: 0`.
- Set `lineHeight: 1` or `1.1`.
- Make sure the terminal container is not CSS-scaled with `transform: scale(...)`.
- Call `fit()` only after the element is visible and fully laid out. [github](https://github.com/xtermjs/xterm.js/issues/2752)

It should not require custom word-wrap code. If you want, paste your Tauri xterm init code plus how you create and resize the PTY, and I can point to the exact missing piece.