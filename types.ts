// Shared types between apps/api and apps/web.

export type TransactionType =
  | 'BUY'
  | 'ADMIN_GRANT'
  | 'USER_TRANSFER'
  | 'USER_BURN'
  | 'STORE_PURCHASE_BURN'
  | 'STORE_PURCHASE_RECYCLE'
  | 'GAME_PURCHASE'
  | 'REDEMPTION'
  | 'REFUND'
  | 'ADJUSTMENT';

export interface EconomicState {
  maxSupplyCap: string;
  circulatingSupply: string;
  availablePool: string;
  destroyedTotal: string;
  reserveAmount: string;
  currentValue: string | null; // null only in the true 0÷0 case (never-yet-circulated genesis)
}

export interface WalletSummary {
  userId: string;
  balance: string;
}

// Single-admin grants are capped in dollar value; anything above requires
// unanimous approval. Keep this in one place so web + api agree.
export const SINGLE_ADMIN_GRANT_CAP_USD = 100;
