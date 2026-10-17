// Generates the animated README art: crawl.svg (opening-crawl homage) and saber-{blue,red,green}.svg (dividers).
// Usage (from the repo root): node docs/assets/readme/tools/gen-readme-art.mjs docs/assets/readme
// Pure 2D CSS animation (no scripts, no external fonts) so it plays inside GitHub's <img> rendering:
// Chromium flattens CSS 3D transforms on SVG elements, so the crawl fakes perspective per line
// (y = HORIZON + K/z, scaleX = 1/z, scaleY = 1/z^1.55, z linear in time). Respects prefers-reduced-motion.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
mkdirSync(out, { recursive: true });

// ---------- deterministic starfield ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const r2 = (n) => Math.round(n * 10) / 10;

function stars(w, h, n, seed) {
  const r = rng(seed);
  let still = "";
  let twinkle = "";
  for (let i = 0; i < n; i++) {
    const x = r2(r() * w);
    const y = r2(r() * h);
    const big = r() < 0.12;
    const rad = big ? r2(0.9 + r() * 0.6) : r2(0.35 + r() * 0.45);
    const op = r2(0.35 + r() * 0.6);
    if (big && r() < 0.6) {
      twinkle += `<circle cx="${x}" cy="${y}" r="${rad}" style="animation-delay:-${r2(r() * 4)}s"/>`;
    } else {
      still += `<circle cx="${x}" cy="${y}" r="${rad}" opacity="${op}"/>`;
    }
  }
  return { still, twinkle };
}

// ---------- crawl ----------
const W = 900;
const H = 360;
const T = 37; // loop period (s)
const D = 17; // travel time of one line (s)
const START = 4.2; // first crawl line starts after the intro
const GAP = 0.82; // between lines
const PARA = 0.7; // extra between paragraphs
const HORIZON = -40;
const K = 440; // y = HORIZON + K / z  (z = 1 at the bottom edge)
const Z0 = 1.0;
const Z1 = 2.75;
const FULL = 650; // justified line width at scale 1

const lines = [
  { t: "EPISODE I", cls: "ep", gap: 1.25 },
  { t: "THE GRID AWAKENS", cls: "ti", gap: 1.1 },
  { para: true },
  { t: "It is a period of terminal chaos. AI agents," },
  { t: "scattered across a dozen lonely windows, wait" },
  { t: "for answers that never come. Orphaned shells" },
  { t: "linger after every crash, and the CPU burns hot" },
  { t: "from a thousand restless polling loops.", last: true },
  { para: true },
  { t: "Developers who command several accounts watch" },
  { t: "their identities collide, and every session is" },
  { t: "lost the moment the console window closes....", last: true },
  { para: true },
  { t: "Now, from the depths of ConPTY, a keeper rises." },
  { t: "Armed with a GPU and Job Objects, it gathers" },
  { t: "every agent into one grid, and keeps watch for" },
  { t: "the one that needs you....", last: true },
];

// keyframes for the perspective path
const STOPS = 18;
const pct = (s) => Math.round((s / T) * 100000) / 1000;
const endPct = pct(D);
let kf = "";
for (let i = 0; i <= STOPS; i++) {
  const f = i / STOPS;
  const z = Z0 + (Z1 - Z0) * f;
  const y = HORIZON + K / z;
  const sx = 1 / z;
  const sy = 1 / Math.pow(z, 1.55);
  // fade out as the line approaches the horizon
  const fade = Math.max(0, Math.min(1, (y - 122) / 80));
  kf += `${Math.round(f * endPct * 1000) / 1000}%{transform:translate(450px,${r2(y)}px) scale(${sx.toFixed(4)},${sy.toFixed(4)});opacity:${fade.toFixed(3)}}`;
}
kf += `100%{transform:translate(450px,${r2(HORIZON + K / Z1)}px) scale(${(1 / Z1).toFixed(4)},${(1 / Math.pow(Z1, 1.55)).toFixed(4)});opacity:0}`;

let d = START;
let crawl = "";
for (const l of lines) {
  if (l.para) {
    d += PARA;
    continue;
  }
  const cls = l.cls ?? "p";
  const attrs = !l.cls && !l.last ? ` textLength="${FULL}" lengthAdjust="spacing"` : "";
  crawl += `<text class="l ${cls}" style="animation-delay:${r2(d)}s"${attrs}>${l.t.replace("....", "…").replace("...", "…")}</text>`;
  d += l.gap ?? GAP;
}
const lastStart = d - GAP;
if (lastStart + D > T - 1) throw new Error(`loop too short: last line ends at ${lastStart + D}s`);

const s = stars(W, H, 150, 7);
const intro = "A long time ago, in a terminal far, far away…";

const crawlSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t d">
<title id="t">Episode I: The Grid Awakens</title>
<desc id="d">An opening-crawl homage. A long time ago, in a terminal far, far away... AI agents are scattered across a dozen windows, orphaned shells linger after every crash and the CPU burns hot. Developers juggling several accounts watch their identities collide. Now a keeper rises, armed with a GPU and Job Objects, gathering every agent into one grid and keeping watch for the one that needs you.</desc>
<style>
.l{font-family:"Segoe UI","Helvetica Neue",Helvetica,Arial,sans-serif;font-weight:700;fill:#ffd84a;text-anchor:middle;transform:translate(450px,420px);opacity:0;animation:c ${T}s linear infinite backwards}
.p{font-size:28px}
.ep{font-size:24px;letter-spacing:6px}
.ti{font-size:46px;letter-spacing:4px}
.in{font-family:"Segoe UI","Helvetica Neue",Helvetica,Arial,sans-serif;font-size:25px;fill:#58c8f0;text-anchor:middle;opacity:0;animation:i ${T}s linear infinite}
.tw circle{animation:w 4s ease-in-out infinite alternate}
.st{display:none}
@keyframes c{${kf}}
@keyframes i{0%{opacity:0}${pct(0.9)}%{opacity:1}${pct(3.1)}%{opacity:1}${pct(3.9)}%{opacity:0}100%{opacity:0}}
@keyframes w{0%{opacity:.25}100%{opacity:1}}
@media (prefers-reduced-motion:reduce){.l,.in{display:none}.tw circle{animation:none}.st{display:inline}}
</style>
<defs><radialGradient id="g" cx="50%" cy="0%" r="90%"><stop offset="0" stop-color="#0c1526"/><stop offset="1" stop-color="#020306"/></radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
<g fill="#fff">${s.still}</g>
<g fill="#fff" class="tw">${s.twinkle}</g>
<text class="in" x="450" y="186">${intro}</text>
${crawl}
<g class="st" font-family="Segoe UI,Helvetica,Arial,sans-serif" font-weight="700" fill="#ffd84a" text-anchor="middle"><text x="450" y="150" font-size="22" letter-spacing="6">EPISODE I</text><text x="450" y="200" font-size="44" letter-spacing="4">THE GRID AWAKENS</text><text x="450" y="244" font-size="18" font-weight="400" fill="#c9d3e3">Every agent in one grid.</text></g>
</svg>
`;
writeFileSync(join(out, "crawl.svg"), crawlSvg);

// ---------- sabers ----------
function saber(name, core, glow, glow2, fromRight) {
  const SW = 880;
  const SH = 24;
  const cy = 12;
  // hilt geometry (drawn for a left hilt, mirrored for a right one)
  const hx = 10;
  const hw = 92;
  const bx0 = hx + hw + 2; // blade start
  const bx1 = SW - 14; // blade tip
  const hilt = `
<g>
<rect x="${hx}" y="${cy - 4}" width="12" height="8" rx="2" fill="#5b6270"/>
<rect x="${hx + 10}" y="${cy - 5}" width="54" height="10" rx="2" fill="url(#m)"/>
${Array.from({ length: 7 }, (_, i) => `<rect x="${hx + 15 + i * 6.6}" y="${cy - 5}" width="2.6" height="10" fill="#1d2129"/>`).join("")}
<rect x="${hx + 64}" y="${cy - 4}" width="8" height="8" fill="#3a404b"/>
<rect x="${hx + 66}" y="${cy - 2.2}" width="3.5" height="4.4" rx="1" fill="${glow}"/>
<rect x="${hx + 72}" y="${cy - 6.5}" width="20" height="13" rx="2" fill="url(#m)"/>
<rect x="${hx + 88}" y="${cy - 7}" width="6" height="14" rx="1.5" fill="#9aa3b2"/>
</g>`;
  const bl = bx1 - bx0;
  const flip = fromRight ? ` transform="matrix(-1 0 0 1 ${SW} 0)"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}" viewBox="0 0 ${SW} ${SH}" role="img" aria-label="${name} energy-blade section divider">
<title>${name} energy-blade divider</title>
<style>
.b{transform-box:view-box;transform-origin:${bx0}px ${cy}px;transform:scaleX(0);animation:ig .55s cubic-bezier(.2,.9,.25,1) .35s forwards}
.h{animation:hm 2.6s ease-in-out 1s infinite alternate}
.f{animation:fl .19s steps(2,end) 1s infinite}
@keyframes ig{0%{transform:scaleX(0)}100%{transform:scaleX(1)}}
@keyframes hm{0%{opacity:.62}100%{opacity:1}}
@keyframes fl{0%{opacity:1}100%{opacity:.88}}
@media (prefers-reduced-motion:reduce){.b{animation:none;transform:none}.h,.f{animation:none}}
</style>
<defs>
<linearGradient id="m" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d9dee6"/><stop offset=".45" stop-color="#8a93a3"/><stop offset="1" stop-color="#3b414c"/></linearGradient>
<filter id="gl" x="-2%" y="-120%" width="104%" height="340%"><feGaussianBlur stdDeviation="3.2"/></filter>
<filter id="gs" x="-2%" y="-80%" width="104%" height="260%"><feGaussianBlur stdDeviation="1.3"/></filter>
</defs>
<g${flip}>
<g class="b">
<g class="h"><rect x="${bx0}" y="${cy - 5}" width="${bl}" height="10" rx="5" fill="${glow2}" filter="url(#gl)"/></g>
<g class="f"><rect x="${bx0}" y="${cy - 3}" width="${bl}" height="6" rx="3" fill="${glow}" filter="url(#gs)"/>
<rect x="${bx0}" y="${cy - 1.6}" width="${bl}" height="3.2" rx="1.6" fill="${core}"/></g>
</g>
${hilt}
</g>
</svg>
`;
}
writeFileSync(join(out, "saber-blue.svg"), saber("Blue", "#f2fbff", "#4cc2ff", "#2f8fff", false));
writeFileSync(join(out, "saber-red.svg"), saber("Red", "#fff3f2", "#ff4040", "#ff1a1a", true));
writeFileSync(join(out, "saber-green.svg"), saber("Green", "#f3fff4", "#48f070", "#1fd64a", false));
console.log("ok, crawl last line starts", lastStart.toFixed(2), "s, ends", (lastStart + D).toFixed(2), "s of", T);
