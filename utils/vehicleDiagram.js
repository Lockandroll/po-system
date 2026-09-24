// Vehicle damage diagram templates, as DATA.
//
// One template is drawn two ways: as SVG in the browser (public/js/vehicleHandoffs.js
// asks for it over GET /api/vehicle-handoffs/diagram/:type) and as vector paths in the
// signed PDF (utils/handoffPdf.js). Keeping the drawing here, as a list of shapes,
// is what stops the page and the PDF from quietly disagreeing about where the
// driver-side door is.
//
// Units are inches. Side views: x = inches from the front bumper (0) to the rear
// (224), y = inches down from the roof (ground = 84). The passenger side is the
// driver side mirrored, so a mark is always stored in the view's OWN coordinates
// (view + x + y), never in canvas pixels. That is what lets a template be redrawn
// later without moving a single signed mark.
//
// Colours are semantic names (body, glass, lampRed...), not hex. The page maps
// them to Nova's dark theme; the PDF maps them to ink on white paper.
//
// Only the Chevy Express is drawn today (Tony, 2026-09-24: "leave what you have").
// It was traced from photos of a 2021 Express 2500 cargo van.
//
// House style: string concatenation only, no template literals/backticks.

function P(d, fill, stroke, w, op) {
  return { t: 'path', d: d, fill: fill || 'body', stroke: stroke || 'line', w: w == null ? 0.7 : w, op: op == null ? 1 : op };
}
function L(x1, y1, x2, y2, c, w) {
  return { t: 'line', x1: x1, y1: y1, x2: x2, y2: y2, stroke: c || 'detail', w: w == null ? 0.45 : w };
}
function R(x, y, w, h, rx, fill, stroke, sw, op) {
  return { t: 'rect', x: x, y: y, w: w, h: h, rx: rx == null ? 0.8 : rx, fill: fill || 'body', stroke: stroke || 'line', sw: sw == null ? 0.6 : sw, op: op == null ? 1 : op };
}
function C(cx, cy, r, fill, stroke, sw) {
  return { t: 'circle', cx: cx, cy: cy, r: r, fill: fill || 'none', stroke: stroke || 'none', sw: sw || 0 };
}
function T(x, y, text, size, fill) {
  return { t: 'text', x: x, y: y, text: text, size: size || 4, fill: fill || 'faint' };
}

function wheel(cx, cy) {
  var out = [
    C(cx, cy, 15, 'tire', 'tireLine', 0.8),
    C(cx, cy, 13.2, 'none', 'tireInner', 1.2),
    C(cx, cy, 8.4, 'rim', 'rimLine', 0.6),
    C(cx, cy, 2.6, 'hub', 'hubLine', 0.4)
  ];
  for (var a = 0; a < 8; a++) {
    var ang = a * 0.785398;
    out.push(C(Math.round((cx + 5.2 * Math.cos(ang)) * 100) / 100, Math.round((cy + 5.2 * Math.sin(ang)) * 100) / 100, 0.55, 'lug', 'none', 0));
  }
  return out;
}

function expressSide(passenger) {
  var s = [];
  s.push(P('M3.5,41 Q3.5,38.5 7,38 L30,34.5 Q40,31.2 44,30.2 L68.5,4.2 Q70.8,1.2 76,0.9 L218,0.9 Q223.6,1.2 223.8,7 L223.8,69 L192,69 A19.5,19.5 0 0 0 153,69 L57,69 A19.5,19.5 0 0 0 18,69 L4,69 Q2.4,56 3.5,41 Z'));
  s.push(P('M49,29.3 L69.6,7.6 Q70.8,6.4 72.6,6.4 L93,6.4 Q95.4,6.4 95.4,8.8 L95.4,29.3 Z', 'glass', 'glassLine', 0.45));
  s.push(L(44, 30.2, 49.5, 36, 'detail', 0.5));
  s.push(P('M49.5,36 Q59,40 59,52 L59,67.5', 'none', 'detail', 0.5));
  s.push(L(98, 2.5, 98, 67.5, 'detail', 0.5));
  s.push(L(59, 67.5, 98, 67.5, 'detail', 0.5));
  s.push(R(89, 35.5, 6, 1.8, 0.9, 'handle', 'handleLine', 0.4));
  s.push(L(76, 3.2, 219, 3.2, 'faintLine', 0.5));
  s.push(L(96, 29.4, 222.5, 29.4, 'crease', 0.7));
  s.push(L(62, 53, 151, 53, 'faintLine', 0.6));
  s.push(L(194, 53, 222, 53, 'faintLine', 0.6));
  s.push(P('M3.6,39.2 L10,38.4 L10.4,44 L3.6,44.5 Z', 'lampHead', 'line', 0.35, 0.75));
  s.push(R(3.6, 45, 6.5, 2.6, 0.6, 'lampAmber', 'none', 0, 0.85));
  s.push(R(11, 47, 3.2, 1.5, 0.5, 'lampAmber', 'none', 0, 0.9));
  s.push(P('M1.2,51 L8.5,51 L9,66 L1.4,66 Q0.2,58.5 1.2,51 Z', 'trim', 'line', 0.55));
  s.push(R(216.5, 56, 9.8, 11, 1.5, 'trim', 'line', 0.55));
  s.push(R(220.6, 17, 3.2, 21, 0.8, 'lampRed', 'lampRedLine', 0.35, 0.9));
  s.push(R(220.6, 34.5, 3.2, 3.5, 0.5, 'lampWhite', 'none', 0, 0.5));
  s.push(R(212.5, 45, 3, 1.5, 0.5, 'lampRed', 'none', 0, 0.9));
  s.push(P('M45.5,20.5 L53.5,19.5 Q55,19.5 55,21 L55,28.5 Q55,30 53.5,30 L46.8,30.3 Q45.3,30.3 45.3,28.8 Z', 'trim', 'line', 0.5));
  if (passenger) {
    s.push(P('M101,67.5 L101,9 Q101,5 105,5 L156,5 Q160,5 160,9 L160,67.5', 'none', 'detail', 0.55));
    s.push(L(130.5, 5, 130.5, 67.5, 'detail', 0.55));
    s.push(R(104, 32, 23.5, 18, 2.5, 'none', 'panel', 0.5));
    s.push(R(134, 32, 23.5, 18, 2.5, 'none', 'panel', 0.5));
    s.push(R(125, 35.5, 4, 1.8, 0.8, 'handle', 'handleLine', 0.35));
    s.push(R(132.5, 35.5, 4, 1.8, 0.8, 'handle', 'handleLine', 0.35));
    s.push(R(159.3, 12, 1.6, 4, 0.4, 'handle', 'handleLine', 0.3));
    s.push(R(159.3, 58, 1.6, 4, 0.4, 'handle', 'handleLine', 0.3));
    s.push(R(164, 7.5, 52, 19.5, 4, 'none', 'panel', 0.55));
  } else {
    s.push(R(104, 34, 8, 7, 1, 'trimDark', 'detail', 0.4));
    s.push(R(102, 7.5, 114, 19.5, 4, 'none', 'panel', 0.55));
  }
  s.push(L(8, 84.6, 218, 84.6, 'ground', 1.4));
  return s.concat(wheel(38, 68.5), wheel(173, 68.5));
}

function expressTop() {
  var s = [];
  s.push(R(46, -8.5, 8, 8, 1.2, 'trim', 'line', 0.5));
  s.push(L(50, -1, 50, 1, 'detail', 0.8));
  s.push(R(46, 80.5, 8, 8, 1.2, 'trim', 'line', 0.5));
  s.push(L(50, 79, 50, 80.5, 'detail', 0.8));
  s.push(R(-1, 5, 4.5, 70, 1.5, 'trim', 'line', 0.55));
  s.push(R(220.5, 7, 5.5, 66, 1.2, 'trim', 'line', 0.55));
  s.push(P('M8,3 L44,1.2 L219,0.6 Q223.6,0.8 223.8,5 L223.8,75 Q223.6,79.2 219,79.4 L44,78.8 L8,77 Q2.5,76 2.5,70 L2.5,10 Q2.5,4 8,3 Z'));
  s.push(P('M44.5,2.2 L69,4.5 L69,75.5 L44.5,77.8 Z', 'glass', 'glassLine', 0.45));
  s.push(P('M71,6.5 L217,6 Q221,6 221,10 L221,70 Q221,74 217,74 L71,73.5 Z', 'none', 'panel', 0.6));
  for (var x = 88; x < 215; x += 15) s.push(L(x, 8, x, 72, 'rib', 0.8));
  s.push(L(10, 16, 43, 14.5, 'panel', 0.6));
  s.push(L(10, 64, 43, 65.5, 'panel', 0.6));
  s.push(T(23, 41.5, 'HOOD', 4, 'faint'));
  s.push(T(146, 41.5, 'ROOF', 4, 'faint'));
  return s;
}

function expressFront() {
  var s = [];
  s.push(R(5, 63, 12.5, 21, 3, 'tire', 'tireLine', 0.6));
  s.push(R(62.5, 63, 12.5, 21, 3, 'tire', 'tireLine', 0.6));
  s.push(P('M-8,19 Q-8,17.5 -6.5,17.5 L-1,17.5 L1,19 L1,29 L-1,30.5 L-6.5,30.5 Q-8,30.5 -8,29 Z', 'trim', 'line', 0.5));
  s.push(P('M88,19 Q88,17.5 86.5,17.5 L81,17.5 L79,19 L79,29 L81,30.5 L86.5,30.5 Q88,30.5 88,29 Z', 'trim', 'line', 0.5));
  s.push(P('M1.2,64 L1.2,34 Q1.2,30.5 3.5,30 L5.5,8 Q6.2,1 13,0.8 L67,0.8 Q73.8,1 74.5,8 L76.5,30 Q78.8,30.5 78.8,34 L78.8,64 Z'));
  s.push(P('M7.2,28.2 L10,7.6 Q10.8,4.2 15,4.2 L65,4.2 Q69.2,4.2 70,7.6 L72.8,28.2 Z', 'glass', 'glassLine', 0.45));
  s.push(L(18, 27.4, 35, 25, 'wiper', 0.9));
  s.push(L(45, 27.4, 62, 25, 'wiper', 0.9));
  s.push(P('M4,31 L76,31 Q77.5,31 77.5,33 L77.5,37 Q77.5,38.2 76,38.2 L4,38.2 Q2.5,38.2 2.5,37 L2.5,33 Q2.5,31 4,31 Z', 'none', 'detail', 0.5));
  s.push(R(2.8, 38.8, 15, 6, 1, 'lampHead', 'line', 0.4, 0.75));
  s.push(R(2.8, 45.3, 15, 3.8, 0.8, 'lampAmber', 'line', 0.35, 0.8));
  s.push(R(62.2, 38.8, 15, 6, 1, 'lampHead', 'line', 0.4, 0.75));
  s.push(R(62.2, 45.3, 15, 3.8, 0.8, 'lampAmber', 'line', 0.35, 0.8));
  s.push(R(18.4, 38.8, 43.2, 11.2, 1, 'grille', 'line', 0.5));
  [41, 43.2, 45.4, 47.6].forEach(function (y) { s.push(L(20, y, 60, y, 'grilleLine', 0.55)); });
  s.push(R(35.5, 42, 9, 4.5, 1, 'trim', 'handleLine', 0.35));
  s.push(P('M1,50.5 L79,50.5 Q79.6,50.5 79.6,51.5 L79.2,64 Q79.1,65 78,65 L2,65 Q0.9,65 0.8,64 L0.4,51.5 Q0.4,50.5 1,50.5 Z', 'trim', 'line', 0.55));
  s.push(R(31, 52.5, 18, 5.6, 0.6, 'plate', 'plateLine', 0.35));
  s.push(R(20, 59.5, 40, 3.2, 1, 'grille', 'plateLine', 0.35));
  return s;
}

function expressRear() {
  var s = [];
  s.push(R(5.5, 64, 12.5, 20, 3, 'tire', 'tireLine', 0.6));
  s.push(R(62, 64, 12.5, 20, 3, 'tire', 'tireLine', 0.6));
  s.push(P('M0.8,66 L0.8,28 L4.5,6 Q5.4,1 11,0.8 L69,0.8 Q74.6,1 75.5,6 L79.2,28 L79.2,66 Z'));
  s.push(P('M9,62 L9,8 Q9,4.2 12.5,4.2 L67.5,4.2 Q71,4.2 71,8 L71,62', 'none', 'detail', 0.55));
  s.push(L(40, 4.2, 40, 62, 'detail', 0.55));
  s.push(R(12, 7.5, 25, 19, 2.5, 'glass', 'glassLine', 0.45));
  s.push(R(43, 7.5, 25, 19, 2.5, 'glass', 'glassLine', 0.45));
  s.push(R(1.6, 25, 6, 19, 1, 'lampRed', 'lampRedLine', 0.35, 0.9));
  s.push(R(1.6, 40, 6, 4, 0.5, 'lampWhite', 'none', 0, 0.45));
  s.push(R(72.4, 25, 6, 19, 1, 'lampRed', 'lampRedLine', 0.35, 0.9));
  s.push(R(72.4, 40, 6, 4, 0.5, 'lampWhite', 'none', 0, 0.45));
  s.push(R(33, 1.4, 14, 1.8, 0.6, 'lampRed', 'none', 0, 0.9));
  s.push(R(45.5, 33, 15, 8, 1.2, 'grille', 'plateLine', 0.4));
  s.push(R(47.5, 34.5, 11, 5, 0.5, 'plate', 'plateLine', 0.3));
  s.push(R(36.5, 36, 3, 1.6, 0.6, 'handle', 'handleLine', 0.35));
  s.push(P('M0.4,58 L79.6,58 L79.6,66 Q79.6,67.5 78,67.5 L2,67.5 Q0.4,67.5 0.4,66 Z', 'trim', 'line', 0.55));
  s.push(R(27, 58.8, 26, 3.2, 0.8, 'grille', 'plateLine', 0.35));
  return s;
}

// Where each view sits on the canvas, and the box a tap must land in to count as
// that view. The box is in the view's own coordinates. flip = -1 mirrors it.
var EXPRESS = {
  key: 'express',
  label: 'Chevy Express cargo, 135 in. WB',
  models: 'Chevy Express 2500 / 3500, GMC Savana',
  viewBox: [0, 0, 440, 320],
  views: {
    ds:    { label: 'Driver side',    x: 112, y: 6,   flip: 1,  box: [-2, -2, 228, 88] },
    top:   { label: 'Top',            x: 112, y: 114, flip: 1,  box: [-2, -10, 228, 90] },
    ps:    { label: 'Passenger side', x: 112, y: 222, flip: -1, box: [-2, -2, 228, 88] },
    front: { label: 'Front',          x: 14,  y: 116, flip: 1,  box: [-12, -2, 92, 86] },
    rear:  { label: 'Rear',           x: 350, y: 116, flip: 1,  box: [-2, -2, 82, 86] }
  },
  mirrorWidth: 224,
  labels: [['DRIVER SIDE', 225, 99], ['TOP', 225, 210], ['PASSENGER SIDE', 225, 315], ['FRONT', 54, 210], ['REAR', 390, 210]],
  shapes: {
    ds: expressSide(false),
    top: expressTop(),
    ps: expressSide(true),
    front: expressFront(),
    rear: expressRear()
  }
};

var TEMPLATES = { express: EXPRESS };
var DEFAULT_TYPE = 'express';

// The two palettes. The page draws line art in light strokes on a dark ground;
// the PDF draws dark ink on white paper.
var PALETTES = {
  dark: {
    body: '#1e1e1e', line: '#cfcfcf', detail: '#7d7d7d', glass: '#2c3a47', glassLine: '#9aa7b3',
    tire: '#0a0a0a', tireLine: '#4d4d4d', tireInner: '#1c1c1c', rim: '#2b2b2b', rimLine: '#8a8a8a',
    hub: '#444444', hubLine: '#999999', lug: '#9a9a9a', handle: '#2e2e2e', handleLine: '#9a9a9a',
    faintLine: '#3a3a3a', crease: '#4a4a4a', lampHead: '#d8d2a6', lampAmber: '#d98a1c', lampRed: '#a3161a',
    lampRedLine: '#e05353', lampWhite: '#e8e8e8', trim: '#262626', trimDark: '#232323', panel: '#333333',
    ground: '#262626', rib: '#2c2c2c', faint: '#5f5f5f', wiper: '#111111', grille: '#121212',
    grilleLine: '#343434', plate: '#3a3a3a', plateLine: '#666666', label: '#7a7a7a'
  },
  paper: {
    body: '#ffffff', line: '#222222', detail: '#777777', glass: '#dfe7ee', glassLine: '#6b7c8c',
    tire: '#3a3a3a', tireLine: '#222222', tireInner: '#555555', rim: '#cfcfcf', rimLine: '#555555',
    hub: '#999999', hubLine: '#444444', lug: '#555555', handle: '#dddddd', handleLine: '#555555',
    faintLine: '#bbbbbb', crease: '#999999', lampHead: '#f3ecc4', lampAmber: '#f2b04a', lampRed: '#d9534f',
    lampRedLine: '#a02622', lampWhite: '#f4f4f4', trim: '#d6d6d6', trimDark: '#eeeeee', panel: '#bbbbbb',
    ground: '#cccccc', rib: '#dddddd', faint: '#999999', wiper: '#444444', grille: '#555555',
    grilleLine: '#888888', plate: '#f4f4f4', plateLine: '#777777', label: '#666666'
  }
};

// Mark colours are the same on page and paper.
var MARK_COLORS = { existing: '#f59e0b', new: '#ef4444', driver: '#3b82f6', repaired: '#22c55e' };

var DAMAGE_KINDS = [
  { key: 'dent', code: 'D', label: 'Dent' },
  { key: 'scratch', code: 'S', label: 'Scratch / scuff' },
  { key: 'crack', code: 'C', label: 'Crack / chip' },
  { key: 'missing', code: 'M', label: 'Missing / broken part' },
  { key: 'rust', code: 'R', label: 'Rust' },
  { key: 'other', code: 'O', label: 'Other' }
];
var SEVERITIES = ['minor', 'moderate', 'major'];

function getTemplate(type) { return TEMPLATES[type] || TEMPLATES[DEFAULT_TYPE]; }
function templateTypes() {
  return Object.keys(TEMPLATES).map(function (k) { return { key: k, label: TEMPLATES[k].label, models: TEMPLATES[k].models }; });
}

// A mark in view coordinates -> canvas coordinates.
function toCanvas(tpl, view, x, y) {
  var v = tpl.views[view];
  if (!v) return null;
  var lx = v.flip === -1 ? (tpl.mirrorWidth - x) : x;
  return { x: v.x + lx, y: v.y + y };
}

// Is (x, y) inside a view's tap box? Used by the server to refuse a mark that
// was placed off the vehicle (a stale client, or a hand-rolled request).
function validPoint(tpl, view, x, y) {
  var v = tpl.views[view];
  if (!v) return false;
  x = Number(x); y = Number(y);
  if (!isFinite(x) || !isFinite(y)) return false;
  return x >= v.box[0] && y >= v.box[1] && x <= v.box[2] && y <= v.box[3];
}

module.exports = {
  TEMPLATES: TEMPLATES, DEFAULT_TYPE: DEFAULT_TYPE, PALETTES: PALETTES, MARK_COLORS: MARK_COLORS,
  DAMAGE_KINDS: DAMAGE_KINDS, SEVERITIES: SEVERITIES,
  getTemplate: getTemplate, templateTypes: templateTypes, toCanvas: toCanvas, validPoint: validPoint
};
