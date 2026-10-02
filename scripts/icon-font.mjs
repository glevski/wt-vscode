// Builds media/wt.ttf: a one-glyph icon font holding the wt mark, so the
// status bar can show it as $(wt-logo). Status bar text takes icons only from
// fonts, never from SVG files, hence this step. Run: npm run icons
//
// The shape is the one in media/wt-mono.svg — a W of four strokes with a node on
// every corner. A font has no strokes, only filled outlines, so each stroke
// becomes a thin rectangle and each node a circle; overlapping outlines of
// the same direction fill as one shape.
import { writeFileSync } from "node:fs";
import svg2ttf from "svg2ttf";

// media/wt-mono.svg's geometry, in its 120×120 box.
const corners = [
  [14, 32],
  [36, 92],
  [60, 48],
  [84, 92],
  [106, 32],
];
const lower = new Set([1, 3]); // the two bottom nodes are the bigger ones

// Heavier than the SVG (stroke 5, nodes 7 and 9): the status bar draws the
// glyph at 16px, where those would come out thinner than a pixel.
const stroke = 7.5;
const nodeRadius = (i) => (lower.has(i) ? 10 : 8);

const em = 1000;
const scale = em / 120;

// Center the mark vertically in the em box, then flip: font coordinates have
// y pointing up, SVG's point down.
const top = Math.min(...corners.map(([, y], i) => y - nodeRadius(i)));
const bottom = Math.max(...corners.map(([, y], i) => y + nodeRadius(i)));
const shift = 60 - (top + bottom) / 2;
const point = ([x, y]) => [x * scale, (120 - (y + shift)) * scale];
const fmt = (n) => Number(n.toFixed(2));

/** A closed clockwise contour (in y-up font coordinates) through the points. */
function polygon(points) {
  const area = points.reduce((sum, [x, y], i) => {
    const [nx, ny] = points[(i + 1) % points.length];
    return sum + (x * ny - nx * y);
  }, 0);
  const ordered = area > 0 ? [...points].reverse() : points;
  return `M${ordered.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join("L")}Z`;
}

function segment(from, to) {
  const [x0, y0] = point(from);
  const [x1, y1] = point(to);
  const length = Math.hypot(x1 - x0, y1 - y0);
  const half = (stroke * scale) / 2;
  const nx = (-(y1 - y0) / length) * half;
  const ny = ((x1 - x0) / length) * half;
  return polygon([
    [x0 + nx, y0 + ny],
    [x1 + nx, y1 + ny],
    [x1 - nx, y1 - ny],
    [x0 - nx, y0 - ny],
  ]);
}

/** A clockwise circle as four cubic curves. */
function circle(center, radius) {
  const [cx, cy] = point(center);
  const r = radius * scale;
  const k = r * 0.5522847498;
  const p = (x, y) => `${fmt(cx + x)} ${fmt(cy + y)}`;
  return (
    `M${p(r, 0)}` +
    `C${p(r, -k)} ${p(k, -r)} ${p(0, -r)}` +
    `C${p(-k, -r)} ${p(-r, -k)} ${p(-r, 0)}` +
    `C${p(-r, k)} ${p(-k, r)} ${p(0, r)}` +
    `C${p(k, r)} ${p(r, k)} ${p(r, 0)}Z`
  );
}

const outline = [
  ...corners.slice(1).map((to, i) => segment(corners[i], to)),
  ...corners.map((center, i) => circle(center, nodeRadius(i))),
].join("");

const svgFont = `<?xml version="1.0" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg"><defs>
<font id="wt" horiz-adv-x="${em}">
<font-face font-family="wt" units-per-em="${em}" ascent="${em}" descent="0"/>
<missing-glyph horiz-adv-x="0"/>
<glyph glyph-name="logo" unicode="&#xE001;" horiz-adv-x="${em}" d="${outline}"/>
</font></defs></svg>`;

// ts: 0 pins the font's timestamps, so rebuilding gives the same bytes
const ttf = svg2ttf(svgFont, { ts: 0, description: "wt icons", url: "https://wt.glevski.com" });
writeFileSync("media/wt.ttf", Buffer.from(ttf.buffer));
console.log(`media/wt.ttf  ${ttf.buffer.length} bytes`);
