import { describe, it, expect } from 'vitest';
import { parsePost, toTransaction } from '../../src/chain/post';

const RAW = `---
title: "Mo's Algorithm và cách tối ưu"
date: 2026-07-28
tags: [cp, algorithm]
series: "Ghi chú thuật toán"
research: 12.5
summary: "Tóm tắt ngắn."
---

Khi làm việc với các truy vấn trên đoạn.
`;

describe('parsePost', () => {
  it('extracts and slugifies frontmatter', () => {
    const post = parsePost('content/posts/2026-07-28-mo-algorithm.md', RAW);
    expect(post.slug).toBe('2026-07-28-mo-algorithm');
    expect(post.title).toBe("Mo's Algorithm và cách tối ưu");
    expect(post.date).toBe('2026-07-28');
    expect(post.tags).toEqual(['cp', 'algorithm']);
    expect(post.series).toBe('ghi-chu-thuat-toan');
    expect(post.research).toBe(12.5);
  });

  it('defaults research to 0 when omitted', () => {
    const raw = RAW.replace('research: 12.5\n', '');
    expect(parsePost('a/2026-07-28-x.md', raw).research).toBe(0);
  });

  it('defaults series to null when omitted', () => {
    const raw = RAW.replace('series: "Ghi chú thuật toán"\n', '');
    expect(parsePost('a/2026-07-28-x.md', raw).series).toBeNull();
  });

  it('accepts a date written as an unquoted YAML date', () => {
    expect(parsePost('a/2026-07-28-x.md', RAW).date).toBe('2026-07-28');
  });

  it('fails loudly when title is missing', () => {
    const raw = RAW.replace(/title:.*\n/, '');
    expect(() => parsePost('a/2026-07-28-x.md', raw)).toThrow(/title/);
  });

  it('fails loudly when date is missing', () => {
    const raw = RAW.replace(/date:.*\n/, '');
    expect(() => parsePost('a/2026-07-28-x.md', raw)).toThrow(/date/);
  });

  it('names the offending file in the error', () => {
    const raw = RAW.replace(/title:.*\n/, '');
    expect(() => parsePost('a/2026-07-28-x.md', raw)).toThrow(/2026-07-28-x\.md/);
  });

  it('accepts a research value with exactly one decimal place', () => {
    const raw = RAW.replace('research: 12.5', 'research: 12.5');
    expect(parsePost('a/2026-07-28-x.md', raw).research).toBe(12.5);
  });

  it('rejects a research value with more than one decimal place', () => {
    // §3.2 — research is hashed at one decimal place (toFixed(1)); a value
    // with more precision would silently round on the way into the hash
    // while tx.value kept the unrounded number, so the ledger's hashed and
    // displayed values would disagree.
    const raw = RAW.replace('research: 12.5', 'research: 12.35');
    expect(() => parsePost('a/2026-07-28-x.md', raw)).toThrow(/one decimal place/);
  });
});

describe('toTransaction', () => {
  it('produces a stable 32-byte hash', async () => {
    const post = parsePost('a/2026-07-28-x.md', RAW);
    const tx = await toTransaction(post, '0xauthor');
    expect(tx.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await toTransaction(post, '0xauthor')).hash).toBe(tx.hash);
  });

  it('sets gas to the word count and value to the research hours', async () => {
    const post = parsePost('a/2026-07-28-x.md', RAW);
    const tx = await toTransaction(post, '0xauthor');
    expect(tx.gasUsed).toBe(9);
    expect(tx.value).toBe(12.5);
  });

  it('addresses one recipient per tag plus the series', async () => {
    const post = parsePost('a/2026-07-28-x.md', RAW);
    const tx = await toTransaction(post, '0xauthor');
    expect(tx.to).toHaveLength(3);
    expect(new Set(tx.to).size).toBe(3);
  });

  it('changes the hash when the body changes', async () => {
    const a = await toTransaction(parsePost('a/x.md', RAW), '0xauthor');
    const b = await toTransaction(
      parsePost('a/x.md', RAW.replace('đoạn.', 'đoạn!')),
      '0xauthor',
    );
    expect(a.hash).not.toBe(b.hash);
  });

  it('changes the hash when only the research value changes', async () => {
    const a = await toTransaction(parsePost('a/x.md', RAW), '0xauthor');
    const b = await toTransaction(
      parsePost('a/x.md', RAW.replace('research: 12.5', 'research: 13.0')),
      '0xauthor',
    );
    expect(a.hash).not.toBe(b.hash);
  });

  it('ignores trailing-whitespace-only edits', async () => {
    const a = await toTransaction(parsePost('a/x.md', RAW), '0xauthor');
    const b = await toTransaction(
      parsePost('a/x.md', RAW.replace('đoạn.\n', 'đoạn.   \n\n\n')),
      '0xauthor',
    );
    expect(a.hash).toBe(b.hash);
  });
});
