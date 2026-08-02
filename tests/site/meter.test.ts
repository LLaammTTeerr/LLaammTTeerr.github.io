import { describe, it, expect } from 'vitest';
import { meterGeometry } from '../../src/site/meter';
import { expectedAttempts } from '../../src/site/chain-data';

// This is the arithmetic behind all three WorkMeter renderings. It used to
// live inline in WorkMeter.astro, unguarded by anything but a manual trace
// of the rendered SVG — extracted here so it has a unit-testable home.

describe('meterGeometry', () => {
  it('reconstructs the nonce from the M2 segment percentages', () => {
    const difficulty = 5;
    const nonce = 994454; // a real mined nonce from the committed ledger
    const { perSegment, segments } = meterGeometry(nonce, difficulty);
    const reconstructed = segments.reduce((sum, pct) => sum + (pct / 100) * perSegment, 0);
    expect(reconstructed).toBeCloseTo(nonce, 0);
  });

  it("places 1x expected attempts exactly at segment index 3's right edge", () => {
    const difficulty = 5;
    const expected = expectedAttempts(difficulty);
    const { perSegment, segments } = meterGeometry(expected, difficulty);
    // Four segments of perSegment attempts each sum to exactly 1x expected.
    expect(4 * perSegment).toBeCloseTo(expected, 6);
    // A nonce landing exactly on the expected value fills segment 3
    // completely and leaves segment 4 untouched.
    expect(segments[3]).toBeCloseTo(100, 6);
    expect(segments[4]).toBeCloseTo(0, 6);
  });

  it("sets the marker's y from the same curve formula as the polyline", () => {
    const difficulty = 5;
    const nonce = 500000;
    const { ratio, markY } = meterGeometry(nonce, difficulty);
    expect(markY).toBeCloseTo(38 - (1 - Math.exp(-ratio)) * 34, 9);
  });

  it('clamps the bar at 100 for a nonce past 3x expected, rather than exceeding it', () => {
    const difficulty = 5;
    const expected = expectedAttempts(difficulty);
    const { barPct } = meterGeometry(expected * 10, difficulty);
    expect(barPct).toBe(100);
  });

  it('marks a block that cost fewer attempts than expected as lucky', () => {
    const difficulty = 5;
    const expected = expectedAttempts(difficulty);
    expect(meterGeometry(expected - 1, difficulty).lucky).toBe(true);
    expect(meterGeometry(expected, difficulty).lucky).toBe(false);
  });
});
