import { Injectable, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminActionType, VoteDecision, Prisma, User, AdminApprovalVote } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

// OPEN ITEM (per spec): the exact approval timeout duration hasn't been
// decided yet (candidates discussed: 24h / 3d / 7d). Using 7 days as a
// placeholder default for this sample — change once a number is picked.
const APPROVAL_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  /** Propose an action that requires unanimous admin agreement.
   *  For LARGE_GRANT actions, the YC amount and price are locked at
   *  proposal time (price-timing rule) so approval delay can't change what
   *  the grant actually costs. */
  async propose(
    proposedByUserId: string,
    actionType: AdminActionType,
    payload: Record<string, unknown>,
    lockedYcAmount?: Decimal,
    lockedPricePerYc?: Decimal,
  ) {
    return this.prisma.adminApproval.create({
      data: {
        actionType,
        payload,
        proposedByUserId,
        lockedYcAmount,
        lockedPricePerYc,
        expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS),
      },
    });
  }

  /** Cast a vote. "Unanimous" is checked as "every current admin has voted
   *  APPROVE" — not a fixed count — so it stays correct as the admin roster
   *  changes over time (per spec, with no artificial cap on admin count). */
  async vote(approvalId: string, adminId: string, decision: VoteDecision) {
    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const approval = await tx.adminApproval.findUniqueOrThrow({ where: { id: approvalId } });

      if (approval.status !== 'PENDING') {
        throw new ConflictException(`Approval is already ${approval.status}.`);
      }

      // One vote per admin — duplicate votes are rejected via the unique
      // constraint on (approvalId, adminId), not silently overwritten.
      await tx.adminApprovalVote.create({
        data: { approvalId, adminId, decision },
      });

      if (decision === 'REJECT') {
        await tx.adminApproval.update({
          where: { id: approvalId },
          data: { status: 'REJECTED', resolvedAt: new Date() },
        });
        return { status: 'REJECTED' };
      }

      if (decision === 'REQUEST_REVISION') {
        await tx.adminApproval.update({
          where: { id: approvalId },
          data: { status: 'REVISION_REQUESTED', resolvedAt: new Date() },
        });
        return { status: 'REVISION_REQUESTED' };
      }

      // decision === 'APPROVE' — check whether every current admin has now
      // voted APPROVE.
      const allAdmins: Pick<User, 'id'>[] = await tx.user.findMany({
        where: { isAdmin: true },
        select: { id: true },
      });
      const votes: AdminApprovalVote[] = await tx.adminApprovalVote.findMany({ where: { approvalId } });
      const approvedAdminIds = new Set(
        votes.filter((v: AdminApprovalVote) => v.decision === 'APPROVE').map((v: AdminApprovalVote) => v.adminId),
      );

      const unanimous = allAdmins.every((a: Pick<User, 'id'>) => approvedAdminIds.has(a.id));

      if (unanimous) {
        await tx.adminApproval.update({
          where: { id: approvalId },
          data: { status: 'APPROVED', resolvedAt: new Date() },
        });
        return { status: 'APPROVED' };
      }

      return { status: 'PENDING', approvedSoFar: approvedAdminIds.size, totalAdmins: allAdmins.length };
    });
  }

  /** Should be run periodically (e.g. a cron job) — auto-approves any
   *  pending proposal whose timeout has passed, in the proposer's favor,
   *  per the confirmed approval-timeout rule. */
  async processExpirations() {
    const expired = await this.prisma.adminApproval.findMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date() } },
    });

    for (const approval of expired) {
      await this.prisma.adminApproval.update({
        where: { id: approval.id },
        data: { status: 'APPROVED', resolvedAt: new Date() },
      });
    }

    return { autoApprovedCount: expired.length };
  }
}
