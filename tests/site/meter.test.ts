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

  // The span is one constant; the tick, the guide line and the `exp` segment
  // are three renderings of the same 1× landmark. These tie each landmark to
  // what the meter actually draws at ratio 1, so they stay true if the span
  // changes — and fail if any consumer restates the constant instead.
  describe('the 1x landmarks agree with what the meter draws at 1x', () => {
    const difficulty = 5;
    const expected = expectedAttempts(difficulty);

    it('spans three times the expected attempts', () => {
      expect(meterGeometry(expected, difficulty).span).toBe(3);
    });

    it('places the M1 tick exactly where a 1x bar ends', () => {
      const { tickPct } = meterGeometry(expected, difficulty);
      expect(meterGeometry(expected, difficulty).barPct).toBeCloseTo(tickPct, 9);
    });

    it('places the M3 guide line exactly where a 1x marker lands', () => {
      const { guideX, markX } = meterGeometry(expected, difficulty);
      expect(markX).toBeCloseTo(guideX, 9);
    });

    it("puts 1x expected on the exp segment's right edge", () => {
      const { expectedSegmentIndex, perSegment } = meterGeometry(expected, difficulty);
      expect(Number.isInteger(expectedSegmentIndex), 'no segment boundary lands on 1x').toBe(true);
      expect((expectedSegmentIndex + 1) * perSegment).toBeCloseTo(expected, 6);
    });

    it('samples the curve across the full span, ending at the right edge', () => {
      const { curve, span } = meterGeometry(expected, difficulty);
      expect(curve[0]!.x).toBe(0);
      expect(curve[curve.length - 1]!.x).toBeCloseTo(200, 9);
      expect(meterGeometry(expected * span, difficulty).markX).toBeCloseTo(200, 9);
    });
  });

  it('marks a block that cost fewer attempts than expected as lucky', () => {
    const difficulty = 5;
    const expected = expectedAttempts(difficulty);
    expect(meterGeometry(expected - 1, difficulty).lucky).toBe(true);
    expect(meterGeometry(expected, difficulty).lucky).toBe(false);
  });
});
