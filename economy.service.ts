import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, PayoutMethod } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

// Single-admin grants above this dollar value require unanimous approval
// (AdminApproval / LARGE_GRANT) instead of executing directly.
const SINGLE_ADMIN_GRANT_CAP_USD = new Decimal(100);

/**
 * EconomyService is the ONLY place allowed to touch CoinSupply or Wallet
 * balances. Every method here corresponds exactly to one row of the
 * Economic State-Transition table in york_coin_implementation_spec.md.
 *
 * Concurrency: every method takes out an explicit row lock (`SELECT ... FOR
 * UPDATE`) on the CoinSupply singleton and/or the relevant Wallet row(s)
 * before reading or writing them, inside the same Prisma $transaction. This
 * is what actually prevents double-spending (Design Rule #3) — two
 * concurrent requests touching the same row will have the second one block
 * until the first commits, rather than both reading stale data and
 * corrupting the balance.
 */
@Injectable()
export class EconomyService {
  constructor(private prisma: PrismaService) {}

  /** Locks the CoinSupply singleton row for the duration of the current
   *  transaction. Must be called before reading supply.* fields whenever
   *  the method is also going to update them. */
  private async lockCoinSupply(tx: Prisma.TransactionClient) {
    await tx.$queryRaw`SELECT id FROM "CoinSupply" WHERE id = 'singleton' FOR UPDATE`;
  }

  /** Locks one or more wallet rows, always in a consistent order (sorted by
   *  id) so two concurrent operations touching the same pair of wallets in
   *  opposite order can never deadlock each other. */
  private async lockWallets(tx: Prisma.TransactionClient, walletIds: string[]) {
    const sorted = [...walletIds].sort();
    for (const id of sorted) {
      await tx.$queryRaw`SELECT id FROM "Wallet" WHERE id = ${id} FOR UPDATE`;
    }
  }

  // ---------------------------------------------------------------------
  // CORE FORMULA
  // ---------------------------------------------------------------------

  /**
   * coin value = reserve ÷ circulating supply
   * Special cases (both explicitly resolved in the spec, not guesses):
   *  - True genesis (circulating === 0 AND lastKnownValue is null): use the
   *    fixed admin-set genesis price.
   *  - Re-genesis (circulating === 0 AND lastKnownValue is set, meaning it
   *    circulated before and drained back to zero): freeze at that last
   *    known value rather than resetting to the genesis price.
   */
  async getCurrentValue(tx: Prisma.TransactionClient = this.prisma): Promise<Decimal> {
    const supply = await tx.coinSupply.findUniqueOrThrow({ where: { id: 'singleton' } });

    if (supply.circulatingSupply.equals(0)) {
      if (supply.lastKnownValue !== null) {
        return supply.lastKnownValue; // re-genesis: frozen value
      }
      return supply.genesisPrice; // true genesis bootstrap
    }

    return supply.reserveAmount.div(supply.circulatingSupply);
  }

  /** Freezes lastKnownValue whenever an event drains circulating supply to
   *  exactly zero, so the next entrant continues from the same price
   *  instead of falling back to an undefined 0÷0 state. */
  private async freezeValueIfDrained(
    tx: Prisma.TransactionClient,
    newCirculatingSupply: Decimal,
    priceAtThisEvent: Decimal,
  ) {
    if (newCirculatingSupply.equals(0)) {
      await tx.coinSupply.update({
        where: { id: 'singleton' },
        data: { lastKnownValue: priceAtThisEvent },
      });
    }
  }

  private async getWalletOrThrow(tx: Prisma.TransactionClient, userId: string) {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new BadRequestException(`No wallet for user ${userId}`);
    return wallet;
  }

  // ---------------------------------------------------------------------
  // BUY  (Reserve ↑, Circulating ↑, Available ↓, Buyer ↑)
  // ---------------------------------------------------------------------
  async buy(userId: string, ycAmount: Decimal) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.lockCoinSupply(tx);
      const supply = await tx.coinSupply.findUniqueOrThrow({ where: { id: 'singleton' } });

      if (supply.availablePool.lessThan(ycAmount)) {
        // Available pool insufficient — per spec this must queue, not fail
        // silently or invent a fallback price.
        return this.enqueuePurchase(tx, userId, ycAmount);
      }

      const price = await this.getCurrentValue(tx);
      const dollarAmount = ycAmount.mul(price);

      const wallet = await this.getWalletOrThrow(tx, userId);
      await this.lockWallets(tx, [wallet.id]);

      const updatedSupply = await tx.coinSupply.update({
        where: { id: 'singleton' },
        data: {
          reserveAmount: { increment: dollarAmount },
          circulatingSupply: { increment: ycAmount },
          availablePool: { decrement: ycAmount },
        },
      });

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: ycAmount } },
      });

      const transaction = await tx.transaction.create({
        data: {
          type: 'BUY',
          ycAmount,
          dollarAmount,
          toWalletId: wallet.id,
          userId,
        },
      });

      return { transaction, supply: updatedSupply, priceUsed: price };
    });
  }

  /** Locks the price/amount at request time (per the price-timing rule) and
   *  queues the purchase for later fulfillment. Queue ordering, cancellation,
   *  and expiration remain an OPEN design item per the spec. */
  private async enqueuePurchase(tx: Prisma.TransactionClient, userId: string, ycAmount: Decimal) {
    const price = await this.getCurrentValue(tx);
    const entry = await tx.purchaseQueueEntry.create({
      data: {
        userId,
        requestedYc: ycAmount,
        lockedPricePerYc: price,
        status: 'PENDING',
      },
    });
    return { queued: true, entry };
  }

  // ---------------------------------------------------------------------
  // ADMIN GRANT  (Reserve ↑ [admin-deposited], Circulating ↑, Available ↓, Recipient ↑)
  // ---------------------------------------------------------------------
  /**
   * @param confirmedRealDeposit The admin's attestation that the matching
   *   dollar amount has actually been physically deposited into the
   *   reserve (bank account / cash box). The system cannot verify this
   *   independently — see the "real-money verification" known limitation.
   * @param approvedAdminApprovalId Required if the grant's dollar value
   *   exceeds SINGLE_ADMIN_GRANT_CAP_USD — must reference an AdminApproval
   *   row with status APPROVED and matching actionType LARGE_GRANT.
   */
  async adminGrant(
    adminId: string,
    userId: string,
    ycAmount: Decimal,
    confirmedRealDeposit: boolean,
    approvedAdminApprovalId?: string,
  ) {
    if (!confirmedRealDeposit) {
      throw new BadRequestException(
        'Grant rejected: reserve is real money — the matching deposit must happen before a grant can be made.',
      );
    }

    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.lockCoinSupply(tx);
      const price = await this.getCurrentValue(tx);
      const dollarValue = ycAmount.mul(price);

      if (dollarValue.greaterThan(SINGLE_ADMIN_GRANT_CAP_USD)) {
        if (!approvedAdminApprovalId) {
          throw new BadRequestException(
            `Grants over $${SINGLE_ADMIN_GRANT_CAP_USD} require unanimous admin approval — propose a LARGE_GRANT action first.`,
          );
        }
        const approval = await tx.adminApproval.findUniqueOrThrow({
          where: { id: approvedAdminApprovalId },
        });
        if (approval.status !== 'APPROVED' || approval.actionType !== 'LARGE_GRANT') {
          throw new BadRequestException('Referenced approval is not an APPROVED LARGE_GRANT.');
        }
      }

      const supply = await tx.coinSupply.findUniqueOrThrow({ where: { id: 'singleton' } });
      if (supply.availablePool.lessThan(ycAmount)) {
        throw new ConflictException(
          'Available pool insufficient for this grant — see spec Finding: grants do not currently define queueing behavior.',
        );
      }

      const wallet = await this.getWalletOrThrow(tx, userId);
      await this.lockWallets(tx, [wallet.id]);

      const updatedSupply = await tx.coinSupply.update({
        where: { id: 'singleton' },
        data: {
          reserveAmount: { increment: dollarValue },
          circulatingSupply: { increment: ycAmount },
          availablePool: { decrement: ycAmount },
        },
      });

      await tx.wallet.update({
        where: { id: wallet.id },
        data: { balance: { increment: ycAmount } },
      });

      const transaction = await tx.transaction.create({
        data: {
          type: 'ADMIN_GRANT',
          ycAmount,
          dollarAmount: dollarValue,
          toWalletId: wallet.id,
          userId,
          metadata: { adminId, approvedAdminApprovalId: approvedAdminApprovalId ?? null },
        },
      });

      return { transaction, supply: updatedSupply, priceUsed: price };
    });
  }

  // ---------------------------------------------------------------------
  // TRANSFER  (no reserve/circulating/available change — coins just move)
  // ---------------------------------------------------------------------
  async transfer(fromUserId: string, toUserId: string, ycAmount: Decimal) {
    if (ycAmount.lessThanOrEqualTo(0)) {
      throw new BadRequestException('Transfer amount must be positive.');
    }

    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const fromWallet = await this.getWalletOrThrow(tx, fromUserId);
      const toWallet = await this.getWalletOrThrow(tx, toUserId);
      // Locked in sorted-id order (not sender-then-recipient order) so a
      // reverse-direction concurrent transfer between the same two wallets
      // can never deadlock against this one.
      await this.lockWallets(tx, [fromWallet.id, toWallet.id]);

      // Re-read balance after acquiring the lock — the value fetched above
      // could be stale if another transaction held the lock first.
      const lockedFromWallet = await tx.wallet.findUniqueOrThrow({ where: { id: fromWallet.id } });
      if (lockedFromWallet.balance.lessThan(ycAmount)) {
        throw new BadRequestException('Insufficient balance for transfer.');
      }

      await tx.wallet.update({ where: { id: fromWallet.id }, data: { balance: { decrement: ycAmount } } });
      await tx.wallet.update({ where: { id: toWallet.id }, data: { balance: { increment: ycAmount } } });

      const transaction = await tx.transaction.create({
        data: {
          type: 'USER_TRANSFER',
          ycAmount,
          fromWalletId: fromWallet.id,
          toWalletId: toWallet.id,
          userId: fromUserId,
        },
      });

      return { transaction };
      // Secondary-market note: this is the ONLY thing York Coin ever records
      // for a peer sale. Any private cash side of the deal is explicitly
      // outside the ledger and outside York Coin's responsibility.
    });
  }

  // ---------------------------------------------------------------------
  // VOLUNTARY BURN  (Circulating ↓, Reserve unchanged, Available unchanged)
  // ---------------------------------------------------------------------
  async burn(userId: string, ycAmount: Decimal) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.lockCoinSupply(tx);
      const wallet = await this.getWalletOrThrow(tx, userId);
      await this.lockWallets(tx, [wallet.id]);

      const lockedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      if (lockedWallet.balance.lessThan(ycAmount)) {
        throw new BadRequestException('Cannot burn more than your balance.');
      }

      const priceBeforeBurn = await this.getCurrentValue(tx);

      const supply = await tx.coinSupply.update({
        where: { id: 'singleton' },
        data: {
          circulatingSupply: { decrement: ycAmount },
          destroyedTotal: { increment: ycAmount },
        },
      });

      await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { decrement: ycAmount } } });

      await this.freezeValueIfDrained(tx, supply.circulatingSupply, priceBeforeBurn);

      const transaction = await tx.transaction.create({
        data: { type: 'USER_BURN', ycAmount, fromWalletId: wallet.id, userId },
      });

      return { transaction, supply };
    });
  }

  // ---------------------------------------------------------------------
  // STORE PURCHASE — burns OR recycles depending on the item's flag
  // ---------------------------------------------------------------------
  async storePurchase(userId: string, storeItemId: string) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.lockCoinSupply(tx);
      const item = await tx.storeItem.findUniqueOrThrow({ where: { id: storeItemId } });
      const wallet = await this.getWalletOrThrow(tx, userId);
      await this.lockWallets(tx, [wallet.id]);

      const lockedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      if (lockedWallet.balance.lessThan(item.priceYc)) {
        throw new BadRequestException('Insufficient balance for this purchase.');
      }

      await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { decrement: item.priceYc } } });

      let supply;
      let type: 'STORE_PURCHASE_BURN' | 'STORE_PURCHASE_RECYCLE';

      if (item.burnsOnPurchase) {
        const priceBefore = await this.getCurrentValue(tx);
        supply = await tx.coinSupply.update({
          where: { id: 'singleton' },
          data: {
            circulatingSupply: { decrement: item.priceYc },
            destroyedTotal: { increment: item.priceYc },
          },
        });
        await this.freezeValueIfDrained(tx, supply.circulatingSupply, priceBefore);
        type = 'STORE_PURCHASE_BURN';
      } else {
        // Recycled coins leave circulating supply (the buyer no longer
        // holds them) and move to the available pool for resale — both
        // fields must change together, or the conservation invariant
        // (cap = circulating + available + destroyed) breaks and repeated
        // recycle→resell cycles would silently mint value past the cap.
        // (This exact bug was caught by the automated test suite in
        // packages/shared/src/__tests__/economics.test.ts — see that file's
        // history/comments for the full explanation.)
        supply = await tx.coinSupply.update({
          where: { id: 'singleton' },
          data: {
            circulatingSupply: { decrement: item.priceYc },
            availablePool: { increment: item.priceYc },
          },
        });
        type = 'STORE_PURCHASE_RECYCLE';
      }

      const transaction = await tx.transaction.create({
        data: { type, ycAmount: item.priceYc, fromWalletId: wallet.id, userId },
      });

      const purchase = await tx.purchase.create({
        data: {
          userId,
          storeItemId: item.id,
          ycAmount: item.priceYc,
          transactionId: transaction.id,
        },
      });

      return { transaction, purchase, supply };
    });
  }

  // ---------------------------------------------------------------------
  // REDEMPTION  (Reserve ↓, Circulating ↓, coins destroyed — NOT recycled)
  // ---------------------------------------------------------------------
  async redeem(userId: string, ycAmount: Decimal, payoutMethod: PayoutMethod) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.lockCoinSupply(tx);
      const wallet = await this.getWalletOrThrow(tx, userId);
      await this.lockWallets(tx, [wallet.id]);

      const lockedWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } });
      if (lockedWallet.balance.lessThan(ycAmount)) {
        throw new BadRequestException('Cannot redeem more than your balance.');
      }

      const price = await this.getCurrentValue(tx);
      const dollarValue = ycAmount.mul(price); // rounded to the cent only at actual payout, per spec

      const supply = await tx.coinSupply.update({
        where: { id: 'singleton' },
        data: {
          reserveAmount: { decrement: dollarValue },
          circulatingSupply: { decrement: ycAmount },
          destroyedTotal: { increment: ycAmount },
        },
      });

      await tx.wallet.update({ where: { id: wallet.id }, data: { balance: { decrement: ycAmount } } });

      await this.freezeValueIfDrained(tx, supply.circulatingSupply, price);

      const redemption = await tx.redemption.create({
        data: {
          userId,
          coinAmount: ycAmount,
          dollarValue: dollarValue.toDecimalPlaces(2), // rounded here, at actual payout
          exchangeRate: price,
          payoutMethod,
          status: 'PENDING', // becomes COMPLETED once cash/check is actually issued
        },
      });

      const transaction = await tx.transaction.create({
        data: {
          type: 'REDEMPTION',
          ycAmount,
          dollarAmount: dollarValue,
          fromWalletId: wallet.id,
          userId,
          referenceId: redemption.id,
        },
      });

      return { redemption, transaction, supply, priceUsed: price };
    });
  }
}
