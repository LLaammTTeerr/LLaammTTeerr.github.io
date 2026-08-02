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

export interface MeterGeometry {
  /** nonce / expectedAttempts(difficulty). */
  ratio: number;
  /** ratio < 1 — the block cost fewer attempts than expected. */
  lucky: boolean;
  /** 16^difficulty (§3.4). */
  expected: number;
  /** M1: bar fill percentage, capped at 3x expected so an unlucky block stays on scale. */
  barPct: number;
  /** M2: attempts represented by one of the twelve segments (expected / 4). */
  perSegment: number;
  /** M2: fill percentage for each of the twelve segments, left to right. */
  segments: number[];
  /** M3: the 13 sampled points of 1 - e^-x across 0..3x, in the 200×40 SVG viewBox. */
  curve: CurvePoint[];
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

  // M1: the bar caps at 3x so an unlucky block stays on scale; the tick marks 1x.
  const barPct = Math.min(ratio / 3, 1) * 100;

  // M2: twelve segments spanning 3x, so four segments is exactly 1x expected.
  const perSegment = (expected * 3) / 12;
  const segments = Array.from({ length: 12 }, (_, i) => {
    const filled = (nonce - i * perSegment) / perSegment;
    return Math.max(0, Math.min(1, filled)) * 100;
  });

  // M3: cumulative probability 1 - e^-x, sampled every 0.25x across 0..3x.
  const curve = Array.from({ length: 13 }, (_, i) => {
    const x = i * 0.25;
    return { x: (x / 3) * 200, y: 38 - (1 - Math.exp(-x)) * 34 };
  });
  const path = toPath(curve);
  const markX = (Math.min(ratio, 3) / 3) * 200;
  const markY = 38 - (1 - Math.exp(-Math.min(ratio, 3))) * 34;
  const fillPath = `${toPath(curve.filter((p) => p.x <= markX))} L${markX.toFixed(2)},${markY.toFixed(2)} L${markX.toFixed(2)},38 Z`;

  return { ratio, lucky, expected, barPct, perSegment, segments, curve, path, markX, markY, fillPath };
}
