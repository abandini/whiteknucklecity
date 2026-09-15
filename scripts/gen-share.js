// Emit 6 banded 1200x630 share/OG SVGs for White Knuckle City.
// Conversion to PNG is done by a separate bash loop (rsvg-convert).
const fs = require('fs');
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });

const BG = '#0b0d10', BG2 = '#12151a', INK = '#f4f1ea', MUT = '#9aa1ab';
const CALM = '#3ba776', KNUCKLE = '#d7263d', KDEEP = '#7d0f1e', GOLD = '#d8b33a';

// name, big word, subline, needle % (0-100), top-accent color
const BANDS = [
  ['rest',   'AT REST',         'No Cleveland game right now. Rare footage.', 6,  MUT],
  ['band-1', 'LOOSE GRIP',      'Cleveland can almost relax.',               12, CALM],
  ['band-2', 'PALMS WARMING',   'Something is brewing.',                     32, GOLD],
  ['band-3', 'KNUCKLES PALING', 'Do not leave the room.',                    57, '#e07a2f'],
  ['band-4', 'FULL CLENCH',     'Nobody speak.',                             79, KNUCKLE],
  ['band-5', 'MAXIMUM GRIP',    'Hold onto something solid.',                94, KDEEP],
];

const FONT = 'Arial, Helvetica, "DejaVu Sans", sans-serif';
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const BX = 100, BW = 1000, BY = 470, BH = 26;

function svg([name, word, sub, pct, accent]) {
  const nx = BX + (BW * pct / 100);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${BG}"/><stop offset="1" stop-color="${BG2}"/></linearGradient>
    <radialGradient id="glow" cx="50%" cy="-10%" r="70%"><stop offset="0" stop-color="${KNUCKLE}" stop-opacity="0.20"/><stop offset="60%" stop-color="${KNUCKLE}" stop-opacity="0"/></radialGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${CALM}"/><stop offset="0.45" stop-color="${GOLD}"/><stop offset="0.78" stop-color="${KNUCKLE}"/><stop offset="1" stop-color="${KDEEP}"/></linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <rect x="0" y="0" width="1200" height="8" fill="${accent}"/>
  <text x="100" y="112" font-family='${FONT}' font-size="30" font-weight="bold" letter-spacing="8" fill="${MUT}">THE WHITE KNUCKLE INDEX</text>
  <text x="100" y="152" font-family='${FONT}' font-size="19" letter-spacing="3" fill="${MUT}" opacity="0.8">Cleveland, Ohio · Guardians · Browns · Cavaliers</text>
  <text x="100" y="330" font-family='${FONT}' font-size="118" font-weight="bold" letter-spacing="1" fill="${INK}">${esc(word)}</text>
  <text x="102" y="392" font-family='${FONT}' font-size="34" font-style="italic" fill="${MUT}">${esc(sub)}</text>
  <rect x="${BX}" y="${BY}" width="${BW}" height="${BH}" rx="13" fill="url(#bar)"/>
  <rect x="${nx-4}" y="${BY-9}" width="8" height="${BH+18}" rx="4" fill="#fff"/>
  <text x="100" y="565" font-family='${FONT}' font-size="24" letter-spacing="2" fill="${MUT}">0 — relaxed</text>
  <text x="1100" y="565" text-anchor="end" font-family='${FONT}' font-size="24" letter-spacing="2" fill="${MUT}">100 — maximum grip</text>
  <text x="1100" y="112" text-anchor="end" font-family='${FONT}' font-size="26" font-weight="bold" letter-spacing="3" fill="${KNUCKLE}">whiteknucklecity.com</text>
</svg>`;
}

for (const b of BANDS) { fs.writeFileSync(`${OUT}/${b[0]}.svg`, svg(b)); console.log('svg', b[0]); }
