import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WalletService {
  constructor(private prisma: PrismaService) {}

  async getBalance(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new NotFoundException('No wallet for this user.');
    return wallet;
  }

  async getHistory(userId: string) {
    return this.prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Reconstructs the whole economy from the ledger alone, ignoring cached
   *  balances — used to verify the "can this be reconstructed from the
   *  ledger?" invariant from the validation report. */
  async reconcileFromLedger() {
    const transactions = await this.prisma.transaction.findMany();

    const walletTotals = new Map<string, number>();
    for (const t of transactions) {
      const amount = Number(t.ycAmount);
      if (t.toWalletId) {
        walletTotals.set(t.toWalletId, (walletTotals.get(t.toWalletId) ?? 0) + amount);
      }
      if (t.fromWalletId) {
        walletTotals.set(t.fromWalletId, (walletTotals.get(t.fromWalletId) ?? 0) - amount);
      }
    }

    return Object.fromEntries(walletTotals);
  }
}
