/**
 * Technical visualisation specs — one per page.
 *
 * These describe *drawings*, not decoration. Each composition is built from the same
 * engineering vocabulary (grid, drawn geometry, nodes, dimension line, measuring
 * sweep) but the geometry and the labels come from what the page is actually about, so
 * no two pages show the same picture.
 *
 * Labels only ever name things the content document supports — verticals, sectors,
 * services, published job families, the office location. Nothing here invents a fact.
 *
 * Rendered by `components/visuals/TechnicalVisual.tsx`.
 */

export type VisualTone = 'line' | 'faint' | 'accent' | 'accentSoft';

export type VisualSpec = {
  id: string;
  width: number;
  height: number;
  /** Small label pair above the frame. */
  caption?: [string, string];
  geometry: { d: string; tone: VisualTone; dash?: string }[];
  nodes: {
    label: string;
    x: number;
    y: number;
    labelX: number;
    labelY: number;
    anchor: 'start' | 'middle' | 'end';
  }[];
  centre?: { x: number; y: number; primary: string; secondary?: string };
  /** Draw centre-to-node connectors and pulses. Default true when a centre exists. */
  connect?: boolean;
  measurement?: { x1: number; x2: number; y: number; label: string };
};

const W = 560;
const H = 420;

/* -------------------------------------------------------------------------- */
/* About — the seven sectors of the group, set out as a survey                  */
/* -------------------------------------------------------------------------- */

export const aboutVisual: VisualSpec = {
  id: 'tv-about',
  width: W,
  height: H,
  caption: ['Group Survey', 'Seven sectors'],
  centre: { x: 280, y: 208, primary: 'JMK', secondary: 'ONE GROUP' },
  geometry: [
    { d: 'M280 56v304M136 208h288', tone: 'faint', dash: '7 6' },
    { d: 'M280 78a130 130 0 0 1 0 260a130 130 0 0 1 0-260', tone: 'line' },
    { d: 'M280 78a130 130 0 0 1 127 159', tone: 'accent' },
    { d: 'M153 237a130 130 0 0 1 25-110', tone: 'accentSoft' },
    { d: 'M280 108a100 100 0 0 1 0 200a100 100 0 0 1 0-200', tone: 'faint', dash: '4 7' },
  ],
  nodes: [
    { label: 'EDUCATION', x: 280, y: 78, labelX: 280, labelY: 48, anchor: 'middle' },
    { label: 'ENGINEERING', x: 382, y: 127, labelX: 408, labelY: 118, anchor: 'start' },
    { label: 'REAL ESTATE', x: 407, y: 237, labelX: 433, labelY: 241, anchor: 'start' },
    { label: 'RENEWABLE', x: 336, y: 325, labelX: 348, labelY: 362, anchor: 'middle' },
    { label: 'EXPORTS', x: 224, y: 325, labelX: 212, labelY: 362, anchor: 'middle' },
    { label: 'AGRICULTURE', x: 153, y: 237, labelX: 127, labelY: 241, anchor: 'end' },
    { label: 'SOFTWARE', x: 178, y: 127, labelX: 152, labelY: 118, anchor: 'end' },
  ],
  measurement: { x1: 130, x2: 430, y: 398, label: '300.00' },
};

/* -------------------------------------------------------------------------- */
/* Our Business — the three operating verticals as a sheet index                */
/* -------------------------------------------------------------------------- */

export const businessVisual: VisualSpec = {
  id: 'tv-business',
  width: W,
  height: H,
  caption: ['Portfolio Sheet', 'Three verticals'],
  connect: false,
  geometry: [
    { d: 'M50 210h460', tone: 'faint', dash: '7 6' },
    { d: 'M140 88h280', tone: 'accent' },
    { d: 'M140 88v32M280 88v32M420 88v32', tone: 'accentSoft' },
    { d: 'M80 120h120v180H80z', tone: 'line' },
    { d: 'M220 120h120v180H220z', tone: 'line' },
    { d: 'M360 120h120v180H360z', tone: 'accentSoft' },
    { d: 'M80 296h120M220 296h120M360 296h120', tone: 'faint' },
    { d: 'M92 140h44M232 140h44M372 140h44', tone: 'faint' },
  ],
  nodes: [
    { label: 'ACADEMY', x: 140, y: 260, labelX: 140, labelY: 222, anchor: 'middle' },
    { label: 'DESIGN STUDIO', x: 280, y: 260, labelX: 280, labelY: 222, anchor: 'middle' },
    { label: 'SOFTWARE', x: 420, y: 260, labelX: 420, labelY: 222, anchor: 'middle' },
  ],
  measurement: { x1: 80, x2: 480, y: 360, label: '400.00' },
};

/* -------------------------------------------------------------------------- */
/* Academy — a training pathway: intake, modules, industry readiness            */
/* -------------------------------------------------------------------------- */

export const academyVisual: VisualSpec = {
  id: 'tv-academy',
  width: W,
  height: H,
  caption: ['Training Pathway', 'CAD · SAP · Zoho'],
  connect: false,
  geometry: [
    // A rising progression line: intake through to placement.
    { d: 'M70 316h420', tone: 'faint', dash: '7 6' },
    { d: 'M70 316 190 250 310 184 430 118', tone: 'accent' },
    { d: 'M70 316V118M70 118h30', tone: 'faint' },
    // Module blocks stepping upward.
    { d: 'M160 262h60v54h-60z', tone: 'line' },
    { d: 'M280 196h60v120h-60z', tone: 'line' },
    { d: 'M400 130h60v186h-60z', tone: 'accentSoft' },
  ],
  nodes: [
    { label: 'FOUNDATION', x: 70, y: 316, labelX: 70, labelY: 350, anchor: 'middle' },
    { label: 'CAD', x: 190, y: 250, labelX: 190, labelY: 232, anchor: 'middle' },
    { label: 'SAP', x: 310, y: 184, labelX: 310, labelY: 166, anchor: 'middle' },
    { label: 'PLACEMENT', x: 430, y: 118, labelX: 430, labelY: 92, anchor: 'middle' },
  ],
  measurement: { x1: 70, x2: 430, y: 384, label: '360.00' },
};

/* -------------------------------------------------------------------------- */
/* Design Studio — an orthographic part with dimensions                        */
/* -------------------------------------------------------------------------- */

export const designVisual: VisualSpec = {
  id: 'tv-design',
  width: W,
  height: H,
  caption: ['Part Drawing', '2D · 3D · Reverse'],
  connect: false,
  geometry: [
    // Plan view: a flange, drawn as a section.
    { d: 'M180 120h200a24 24 0 0 1 24 24v132a24 24 0 0 1-24 24H180a24 24 0 0 1-24-24V144a24 24 0 0 1 24-24z', tone: 'line' },
    { d: 'M280 140a70 70 0 1 1 0 140a70 70 0 1 1 0-140', tone: 'accent' },
    { d: 'M280 178a32 32 0 1 1 0 64a32 32 0 1 1 0-64', tone: 'accentSoft' },
    // Centre lines and bolt circle.
    { d: 'M280 104v212M148 210h264', tone: 'faint', dash: '9 6' },
    { d: 'M280 132a78 78 0 1 1 0 156a78 78 0 1 1 0-156', tone: 'faint', dash: '4 6' },
    // Leader line to a callout.
    { d: 'M350 158 420 118h56', tone: 'accentSoft' },
  ],
  nodes: [
    { label: 'Ø140', x: 350, y: 158, labelX: 486, labelY: 114, anchor: 'end' },
    { label: 'DRAFTING', x: 156, y: 120, labelX: 132, labelY: 116, anchor: 'end' },
    { label: 'MODELLING', x: 404, y: 300, labelX: 428, labelY: 320, anchor: 'start' },
  ],
  measurement: { x1: 156, x2: 404, y: 380, label: '248.00' },
};

/* -------------------------------------------------------------------------- */
/* Software — a system architecture stack                                       */
/* -------------------------------------------------------------------------- */

export const softwareVisual: VisualSpec = {
  id: 'tv-software',
  width: W,
  height: H,
  caption: ['System Architecture', 'ERP · Web · Cloud'],
  centre: { x: 280, y: 214, primary: 'ERP', secondary: 'CORE PLATFORM' },
  geometry: [
    // Three horizontal tiers.
    { d: 'M80 108h400M80 320h400', tone: 'faint', dash: '7 6' },
    { d: 'M110 78h340v60H110z', tone: 'line' },
    { d: 'M110 290h340v60H110z', tone: 'line' },
    { d: 'M280 138v36M280 254v36', tone: 'accentSoft' },
    { d: 'M150 138 150 290M410 138 410 290', tone: 'faint', dash: '5 7' },
  ],
  nodes: [
    { label: 'WEB', x: 170, y: 108, labelX: 170, labelY: 66, anchor: 'middle' },
    { label: 'MOBILE', x: 390, y: 108, labelX: 390, labelY: 66, anchor: 'middle' },
    { label: 'ANALYTICS', x: 170, y: 320, labelX: 170, labelY: 366, anchor: 'middle' },
    { label: 'CLOUD', x: 390, y: 320, labelX: 390, labelY: 366, anchor: 'middle' },
  ],
  measurement: { x1: 110, x2: 450, y: 396, label: '340.00' },
};

/* -------------------------------------------------------------------------- */
/* Careers — the growth path: JMK branches into learn/create/grow, then future  */
/* -------------------------------------------------------------------------- */

export const careersVisual: VisualSpec = {
  id: 'tv-careers',
  width: W,
  height: H,
  caption: ['Growth Path', 'Learn · Create · Grow'],
  centre: { x: 280, y: 78, primary: 'JMK', secondary: 'JOIN THE TEAM' },
  connect: false,
  geometry: [
    { d: 'M280 118v26', tone: 'accent' },
    { d: 'M118 144h324', tone: 'accent' },
    { d: 'M118 144v30M442 144v30', tone: 'accentSoft' },
    { d: 'M280 144v186', tone: 'accentSoft' },
    { d: 'M118 218v68M442 218v68', tone: 'line' },
    { d: 'M118 286h324', tone: 'line' },
    { d: 'M271 300l9 12l9-12', tone: 'accent' },
    { d: 'M50 144h56M454 144h56', tone: 'faint', dash: '6 6' },
    { d: 'M50 286h56M454 286h56', tone: 'faint', dash: '6 6' },
  ],
  nodes: [
    { label: 'LEARN', x: 118, y: 196, labelX: 88, labelY: 200, anchor: 'end' },
    { label: 'CREATE', x: 280, y: 196, labelX: 312, labelY: 200, anchor: 'start' },
    { label: 'GROW', x: 442, y: 196, labelX: 472, labelY: 200, anchor: 'start' },
    { label: 'FUTURE', x: 280, y: 330, labelX: 280, labelY: 372, anchor: 'middle' },
  ],
  measurement: { x1: 118, x2: 442, y: 400, label: '324.00' },
};

/* -------------------------------------------------------------------------- */
/* Contact — a site plan of the Coimbatore office                              */
/* -------------------------------------------------------------------------- */

export const contactVisual: VisualSpec = {
  id: 'tv-contact',
  width: W,
  height: H,
  caption: ['Site Plan', 'Coimbatore, Tamil Nadu'],
  connect: false,
  geometry: [
    // Road and plot lines.
    { d: 'M60 300h440', tone: 'accentSoft' },
    { d: 'M60 314h440', tone: 'faint', dash: '14 12' },
    { d: 'M170 130h220v170H170z', tone: 'line' },
    { d: 'M170 130 280 78 390 130', tone: 'accent' },
    // Survey crosshair on the building.
    { d: 'M280 96v220M140 214h280', tone: 'faint', dash: '9 7' },
    { d: 'M240 214a40 40 0 1 1 80 0a40 40 0 1 1-80 0', tone: 'faint', dash: '4 6' },
  ],
  nodes: [
    { label: '22 NSR ROAD', x: 280, y: 214, labelX: 280, labelY: 190, anchor: 'middle' },
    { label: 'SAIBABA KOVIL', x: 170, y: 300, labelX: 146, labelY: 292, anchor: 'end' },
    { label: '641011', x: 390, y: 300, labelX: 414, labelY: 292, anchor: 'start' },
  ],
  measurement: { x1: 170, x2: 390, y: 380, label: '220.00' },
};

/**
 * Keyed by vertical slug so `VerticalDetail` — which renders all three business
 * pages from one component — still gives each page its own drawing.
 */
export const verticalVisuals: Record<string, VisualSpec> = {
  'jmk-academy': academyVisual,
  'jmk-design-studio': designVisual,
  'jmk-software-solutions': softwareVisual,
};
