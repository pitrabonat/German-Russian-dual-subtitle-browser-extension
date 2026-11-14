// Styles of the subtitle overlay and the word panel. They live inside a shadow root, so page
// styles cannot leak in and ours cannot leak out.
//
// Motion policy: subtitle lines change hundreds of times per video and never animate.
// The word panel fades in over 110 ms on the first hover and switches instantly between
// neighbouring words. Only opacity and transform are animated.
export const OVERLAY_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }

.stage {
  --fs: 24px; --de: #fff; --ru: #ffd98a; --bg: .62; --gap: .18; --ru-scale: .82; --bottom: 9%; --lift: 0px;
  --ease-out: cubic-bezier(.23, 1, .32, 1);
  position: absolute; inset: 0; pointer-events: none; overflow: visible;
  font-family: "YouTube Noto", Roboto, "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased; user-select: none; -webkit-user-select: none;
}
.stage[hidden] { display: none; }

.block {
  position: absolute; left: 50%; bottom: var(--bottom);
  width: max-content; max-width: 88%;
  display: flex; flex-direction: column; align-items: center; gap: calc(var(--fs) * var(--gap));
  text-align: center;
  transform: translate(-50%, calc(-1 * var(--lift)));
  transition: transform 180ms var(--ease-out);
}

.line { margin: 0; font-size: var(--fs); line-height: 1.42; font-weight: 500; color: var(--de); text-wrap: balance; overflow-wrap: anywhere; }
.line[hidden] { display: none; }
.line .bg {
  padding: .14em .5em .18em; border-radius: .28em;
  background: rgba(8, 8, 10, var(--bg));
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .85), 0 0 1px rgba(0, 0, 0, .9);
}
.line.ru { font-size: calc(var(--fs) * var(--ru-scale)); font-weight: 400; color: var(--ru); }
.line.ru.pending .bg { color: color-mix(in srgb, var(--ru) 55%, transparent); letter-spacing: .12em; }
/* A translation that arrives after its German line fades in; lines that arrive together do not. */
.line.ru.late .bg { animation: ml-fade 140ms var(--ease-out); }
@keyframes ml-fade { from { opacity: 0; } }

.w {
  pointer-events: auto; cursor: pointer;
  padding: .02em .07em; margin: 0 -.07em; border-radius: .2em;
  transition: background-color 100ms ease;
}
@media (hover: hover) and (pointer: fine) {
  .w:hover { background-color: rgba(255, 255, 255, .2); }
}
.w.on { background-color: rgba(255, 255, 255, .26); }
/* The other half of a separable verb: "stehe … auf". */
.w.linked { background-color: rgba(255, 217, 138, .24); box-shadow: inset 0 -.09em 0 rgba(255, 217, 138, .95); }

.chip {
  position: absolute; top: 12px; left: 12px; max-width: min(70%, 520px);
  padding: 7px 11px; border-radius: 9px;
  font-size: 12.5px; line-height: 1.35; color: #eceef2;
  background: rgba(18, 19, 24, .82); box-shadow: 0 0 0 1px rgba(255, 255, 255, .08) inset;
  backdrop-filter: blur(10px);
  opacity: 0; transform: translateY(-4px);
  transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out);
}
.chip.show { opacity: 1; transform: none; }
.chip.error { box-shadow: 0 0 0 1px rgba(255, 120, 120, .45) inset; }
.chip b { font-weight: 600; color: #fff; }

.pop {
  --x: 0px; --y: 0px; --ox: 50%;
  position: absolute; left: 0; top: 0; z-index: 2;
  width: max-content; min-width: 210px; max-width: min(372px, calc(100% - 16px));
  padding: 12px 14px; border-radius: 12px;
  font-size: 13.5px; line-height: 1.42; text-align: left; color: #eef0f4;
  background: rgba(21, 22, 27, .95);
  box-shadow: 0 12px 36px rgba(0, 0, 0, .52), 0 0 0 1px rgba(255, 255, 255, .09) inset;
  backdrop-filter: blur(14px) saturate(1.15);
  pointer-events: auto; user-select: text; -webkit-user-select: text; cursor: default;
  opacity: 0; visibility: hidden;
  transform: translate3d(var(--x), var(--y), 0) scale(.97);
  transform-origin: var(--ox) 100%;
  transition: opacity 80ms ease-out, transform 80ms ease-out, visibility 0s linear 80ms;
}
.pop.below { transform-origin: var(--ox) 0; }
.pop.open {
  opacity: 1; visibility: visible;
  transform: translate3d(var(--x), var(--y), 0) scale(1);
  transition: opacity 110ms var(--ease-out), transform 110ms var(--ease-out), visibility 0s;
}
.pop.instant, .pop.instant.open { transition: none; }
/* On small players the panel may be taller than the video: scroll inside instead of clipping. */
.pop { max-height: calc(100% - 12px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, .25) transparent; }

.head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.title { font-size: 18px; font-weight: 600; letter-spacing: -.005em; color: #fff; overflow-wrap: anywhere; }
.art { font-weight: 500; }
.art.m { color: #8ab8ff; } .art.f { color: #ff9aa5; } .art.n { color: #86dfa4; } .art.p { color: #d9c08a; }
.tags { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; flex: none; max-width: 55%; }
.tag { padding: 1px 7px; border-radius: 999px; font-size: 11px; line-height: 1.5; color: #c9cdd6; background: rgba(255, 255, 255, .09); white-space: nowrap; }

.tr { margin-top: 3px; font-size: 15.5px; font-weight: 500; color: #ffd98a; overflow-wrap: anywhere; }
.tr.wait { color: #9aa0ab; font-weight: 400; font-size: 13.5px; }
.q { margin-left: 3px; font-size: 11px; font-weight: 600; color: #f0b56a; cursor: help; vertical-align: .25em; }
.src { margin-left: 6px; font-size: 11px; font-weight: 400; color: #8e94a0; }

.rows { margin: 9px 0 0; padding: 8px 0 0; border-top: 1px solid rgba(255, 255, 255, .09); display: grid; grid-template-columns: max-content 1fr; column-gap: 12px; row-gap: 3px; }
.rows dt { color: #969ca8; white-space: nowrap; }
.rows dd { margin: 0; color: #eef0f4; overflow-wrap: anywhere; }

.conj { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, .09); display: grid; grid-template-columns: 1fr 1fr; column-gap: 14px; row-gap: 2px; font-size: 12.5px; color: #d5d9e0; }
.conj .lbl { grid-column: 1 / -1; margin-bottom: 2px; color: #969ca8; }
.conj i { font-style: normal; color: #969ca8; }

.more { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255, 255, 255, .09); font-size: 12.5px; color: #c5cad3; }
.more .lbl { color: #969ca8; }
.more + .more { margin-top: 4px; padding-top: 0; border-top: 0; }
.ex { margin-top: 8px; font-size: 12.5px; color: #c5cad3; font-style: italic; }
.ex .exru { display: block; font-style: normal; color: #969ca8; }
.foot { margin-top: 8px; font-size: 11px; color: #8e94a0; }

@media (prefers-reduced-motion: reduce) {
  .block, .chip { transition: none; }
  .pop, .pop.open { transition: opacity 80ms linear, visibility 0s; transform: translate3d(var(--x), var(--y), 0); }
}
`;
