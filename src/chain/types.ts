export type Hex = string;

export type TxType = 'post' | 'amendment';

/** A post as parsed from disk, before it becomes a transaction. */
export interface PostInput {
  slug: string;
  title: string;
  date: string;          // YYYY-MM-DD
  tags: string[];        // already slugified
  series: string | null; // already slugified
  research: number;      // hours
  summary: string;
  body: string;          // raw markdown, not yet normalized
}

export interface Transaction {
  hash: Hex;
  type: TxType;
  slug: string | null;      // null for amendments
  title: string | null;     // null for amendments
  date: string;
  tags: string[];
  series: string | null;
  from: Hex;
  to: Hex[];                // tag/series addresses; empty for amendments
  contentHash: Hex;
  gasUsed: number;          // word count; 0 for amendments
  value: number;            // research hours; 0 for amendments
  amends: Hex | null;
}

export interface BlockHeader {
  height: number;
  prevHash: Hex;
  merkleRoot: Hex;
  timestamp: string;   // ISO 8601 UTC
  txCount: number;
  gasUsed: number;
  difficulty: number;
  nonce: number;
}

export interface Block extends BlockHeader {
  hash: Hex;
  period: string;      // YYYY-MM, the calendar month this block belongs to
  value: number;       // sum of transaction values
  transactions: Transaction[];
}

export interface Chain {
  version: 1;
  difficulty: number;
  blocks: Block[];
}
