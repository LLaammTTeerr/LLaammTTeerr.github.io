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
  /**
   * §3.2b — content hashes of the files this transaction's body references.
   * Committed to the transaction hash, so swapping a published diagram
   * invalidates the post that uses it. `toTransaction` stores these sorted
   * as a side effect of building the canonical form, but nothing downstream
   * depends on that — canonicalization sorts independently, so a caller
   * (e.g. one round-tripping through the lock) must not assume the stored
   * order is significant.
   */
  assets: Hex[];
  gasUsed: number;          // word count; 0 for amendments
  value: number;            // research hours; 0 for amendments (§3.9)
  /**
   * §3.9 — the research hours an amendment declares for the post it amends.
   * `null` on a post, where `value` already records the same number. An
   * amendment cannot use `value` for this: `value` must stay 0 so block
   * aggregation does not re-charge hours already counted in the block that
   * sealed the original. Serialized only for amendments.
   */
  research: number | null;
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

/** §3.2b — a minted asset's frozen identity on the chain. */
export interface AssetRecord {
  tokenId: number;
  hash: Hex;
  file: string;
  mime: string;
  bytes: number;
  /** Height of the block whose transaction first referenced this asset. */
  mintedIn: number;
}

export interface Chain {
  version: 1;
  difficulty: number;
  blocks: Block[];
  assets: AssetRecord[];
}
