export interface ChainConfig {
  difficulty: number;
  maxTxPerBlock: number;
  authorHandle: string;
  authorName: string;
}

export const CHAIN_CONFIG: ChainConfig = {
  difficulty: 5,
  maxTxPerBlock: 4,
  authorHandle: 'lamter',
  authorName: 'lamter.eth',
};
