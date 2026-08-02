import { describe, it, expect } from 'vitest';
import {
  normalizeBody,
  wordCount,
  formatResearch,
  canonicalPostTx,
  canonicalAmendmentTx,
  canonicalBlockHeader,
} from '../../src/chain/canonical';

describe('normalizeBody', () => {
  it('converts CRLF and CR to LF', () => {
    expect(normalizeBody('a\r\nb\rc')).toBe('a\nb\nc\n');
  });

  it('strips trailing whitespace from each line', () => {
    expect(normalizeBody('a   \nb\t\n')).toBe('a\nb\n');
  });

  it('collapses trailing newlines to exactly one', () => {
    expect(normalizeBody('a\n\n\n')).toBe('a\n');
  });

  it('adds a trailing newline when absent', () => {
    expect(normalizeBody('a')).toBe('a\n');
  });

  it('preserves interior blank lines', () => {
    expect(normalizeBody('a\n\nb')).toBe('a\n\nb\n');
  });

  it('is idempotent', () => {
    const once = normalizeBody('a  \r\n\r\nb\n\n\n');
    expect(normalizeBody(once)).toBe(once);
  });
});

describe('wordCount', () => {
  it('counts whitespace-separated tokens', () => {
    expect(wordCount('mot hai ba\n')).toBe(3);
  });

  it('returns 0 for an empty body', () => {
    expect(wordCount('\n')).toBe(0);
  });

  it('does not double-count runs of whitespace', () => {
    expect(wordCount('a    b\n\n\tc\n')).toBe(3);
  });
});

describe('formatResearch', () => {
  it('always emits exactly one decimal place', () => {
    expect(formatResearch(12.5)).toBe('12.5');
    expect(formatResearch(12)).toBe('12.0');
    expect(formatResearch(0)).toBe('0.0');
    expect(formatResearch(40)).toBe('40.0');
  });

  it('collapses equivalent literals to one representation', () => {
    expect(formatResearch(12.5)).toBe(formatResearch(12.50));
  });
});

describe('canonicalPostTx', () => {
  const base = {
    title: "Mo's Algorithm",
    date: '2026-07-28',
    tags: ['cp', 'algorithm'],
    series: 'ghi-chu-thuat-toan',
    research: 12.5,
    from: '0xaaaa',
    contentHash: '0xbbbb',
  };

  it('emits the exact field order from the spec', () => {
    expect(canonicalPostTx(base)).toBe(
      [
        'post/1',
        "title:Mo's Algorithm",
        'date:2026-07-28',
        'tags:algorithm,cp',
        'series:ghi-chu-thuat-toan',
        'research:12.5',
        'from:0xaaaa',
        'body:0xbbbb',
      ].join('\n'),
    );
  });

  it('sorts tags so declaration order cannot change the hash', () => {
    expect(canonicalPostTx({ ...base, tags: ['algorithm', 'cp'] })).toBe(
      canonicalPostTx({ ...base, tags: ['cp', 'algorithm'] }),
    );
  });

  it('lowercases tags', () => {
    expect(canonicalPostTx({ ...base, tags: ['CP', 'Algorithm'] })).toContain(
      'tags:algorithm,cp',
    );
  });

  it('renders a null series as an empty value', () => {
    expect(canonicalPostTx({ ...base, series: null })).toContain('\nseries:\n');
  });

  it('has no trailing newline', () => {
    expect(canonicalPostTx(base).endsWith('\n')).toBe(false);
  });
});

describe('canonicalAmendmentTx', () => {
  const base = {
    amends: '0xdead',
    date: '2026-07-28',
    title: "Mo's Algorithm",
    tags: ['cp', 'algorithm'],
    series: 'ghi-chu-thuat-toan',
    research: 12.5,
    from: '0xaaaa',
    contentHash: '0xbeef',
  };

  it('emits the exact amendment/1 field order', () => {
    expect(canonicalAmendmentTx(base)).toBe(
      [
        'amendment/1',
        'amends:0xdead',
        'date:2026-07-28',
        "title:Mo's Algorithm",
        'tags:algorithm,cp',
        'series:ghi-chu-thuat-toan',
        'research:12.5',
        'from:0xaaaa',
        'body:0xbeef',
      ].join('\n'),
    );
  });

  it('changes when only the title changes', () => {
    expect(canonicalAmendmentTx({ ...base, title: 'Khác' })).not.toBe(canonicalAmendmentTx(base));
  });

  it('changes when only the research figure changes', () => {
    expect(canonicalAmendmentTx({ ...base, research: 13 })).not.toBe(canonicalAmendmentTx(base));
  });

  it('sorts and lowercases tags like the post form', () => {
    expect(canonicalAmendmentTx({ ...base, tags: ['CP', 'Algorithm'] })).toBe(
      canonicalAmendmentTx(base),
    );
  });

  it('renders a null series as an empty value', () => {
    expect(canonicalAmendmentTx({ ...base, series: null })).toContain('\nseries:\n');
  });

  it('has no trailing newline', () => {
    expect(canonicalAmendmentTx(base).endsWith('\n')).toBe(false);
  });

  it('gives posts and amendments distinct, independently versioned prefixes', () => {
    expect(canonicalPostTx(base).startsWith('post/1\n')).toBe(true);
    expect(
      canonicalAmendmentTx({
        amends: '0xdead', date: '2026-07-28', title: 'x', tags: [],
        series: null, research: 0, from: '0xaaaa', contentHash: '0xbeef',
      }).startsWith('amendment/1\n'),
    ).toBe(true);
  });
});

describe('canonicalBlockHeader', () => {
  it('emits the exact field order from the spec', () => {
    expect(
      canonicalBlockHeader({
        height: 42,
        prevHash: '0x00',
        merkleRoot: '0x11',
        timestamp: '2026-07-31T00:00:00Z',
        txCount: 4,
        gasUsed: 11240,
        difficulty: 5,
        nonce: 148203,
      }),
    ).toBe(
      [
        'block/1',
        'height:42',
        'prevHash:0x00',
        'merkleRoot:0x11',
        'timestamp:2026-07-31T00:00:00Z',
        'txCount:4',
        'gasUsed:11240',
        'difficulty:5',
        'nonce:148203',
      ].join('\n'),
    );
  });
});
