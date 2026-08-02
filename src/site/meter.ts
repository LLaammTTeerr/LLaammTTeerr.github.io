import { expectedAttempts } from './chain-data';

/**
 * The pure geometry behind all three work-meter renderings (M1 bar, M2
 * segments, M3 curve). Kept out of `WorkMeter.astro` so the arithmetic —
 * bar clamping, segment boundaries, the curve sample and its marker — has a
 * unit-testable home instead of resting on a manual trace of the rendered
 * SVG.
 */

export interface CurvePoint {
  x: number;
  y: number;
}

/**
 * The meter's horizontal span, in multiples of expected attempts. M1's bar,
 * M2's twelve segments and M3's curve all cover 0..SPAN×, and every 1×
 * landmark — the bar's tick, the segment boundary, the curve's guide line —
 * is derived from it below. Nothing downstream may restate it: a CSS
 * `left: 33.33%` or an SVG `x1="66.67"` is the same constant written a
 * second time, and it does not move when this one does.
 */
const SPAN = 3;

/** M2 segment count. SEGMENTS / SPAN must be a whole number, or no segment
 * boundary lands on 1× expected and the `exp` marker has nowhere to sit. */
const SEGMENTS = 12;

/** M3 viewBox width; the SVG is `0 0 200 40`. */
const VIEW_W = 200;

export interface MeterGeometry {
  /** nonce / expectedAttempts(difficulty). */
  ratio: number;
  /** ratio < 1 — the block cost fewer attempts than expected. */
  lucky: boolean;
  /** 16^difficulty (§3.4). */
  expected: number;
  /** How many multiples of `expected` the meter spans, left edge to right. */
  span: number;
  /** M1: bar fill percentage, capped at `span`× expected so an unlucky block stays on scale. */
  barPct: number;
  /** M1: where the 1× tick sits, as a percentage of the bar's width. */
  tickPct: number;
  /** M2: attempts represented by one of the twelve segments (expected / 4). */
  perSegment: number;
  /** M2: fill percentage for each of the twelve segments, left to right. */
  segments: number[];
  /** M2: index of the segment whose right edge is exactly 1× expected. */
  expectedSegmentIndex: number;
  /** M3: the 13 sampled points of 1 - e^-x across 0..span×, in the 200×40 SVG viewBox. */
  curve: CurvePoint[];
  /** M3: x of the 1× guide line, in SVG viewBox space. */
  guideX: number;
  /** M3: the polyline through `curve`. */
  path: string;
  /** M3: x of the ratio marker, in SVG viewBox space. */
  markX: number;
  /** M3: y of the ratio marker, in SVG viewBox space — same formula as `curve`'s y. */
  markY: number;
  /**
   * M3: the shaded region under the curve up to the marker. Built from the
   * same `curve` points as `path`, not recomputed — otherwise the shaded
   * edge can drift from the line it's meant to shade under.
   */
  fillPath: string;
}

function toPath(points: CurvePoint[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
}

/** §9 — the geometry behind M1 (bar), M2 (segments) and M3 (curve). */
export function meterGeometry(nonce: number, difficulty: number): MeterGeometry {
  const expected = expectedAttempts(difficulty);
  const ratio = nonce / expected;
  const lucky = ratio < 1;

  // M1: the bar caps at SPAN× so an unlucky block stays on scale; the tick marks 1×.
  const barPct = Math.min(ratio / SPAN, 1) * 100;
  const tickPct = 100 / SPAN;

  // M2: SEGMENTS segments spanning SPAN×, so SEGMENTS/SPAN of them is exactly 1×.
  const perSegment = (expected * SPAN) / SEGMENTS;
  const segments = Array.from({ length: SEGMENTS }, (_, i) => {
    const filled = (nonce - i * perSegment) / perSegment;
    return Math.max(0, Math.min(1, filled)) * 100;
  });
  const expectedSegmentIndex = SEGMENTS / SPAN - 1;

  // M3: cumulative probability 1 - e^-x, sampled SEGMENTS times across 0..SPAN×.
  const curve = Array.from({ length: SEGMENTS + 1 }, (_, i) => {
    const x = i * (SPAN / SEGMENTS);
    return { x: (x / SPAN) * VIEW_W, y: 38 - (1 - Math.exp(-x)) * 34 };
  });
  const path = toPath(curve);
  const guideX = VIEW_W / SPAN;
  const markX = (Math.min(ratio, SPAN) / SPAN) * VIEW_W;
  const markY = 38 - (1 - Math.exp(-Math.min(ratio, SPAN))) * 34;
  const fillPath = `${toPath(curve.filter((p) => p.x <= markX))} L${markX.toFixed(2)},${markY.toFixed(2)} L${markX.toFixed(2)},38 Z`;

  return {
    ratio, lucky, expected, span: SPAN,
    barPct, tickPct,
    perSegment, segments, expectedSegmentIndex,
    curve, guideX, path, markX, markY, fillPath,
  };
}
