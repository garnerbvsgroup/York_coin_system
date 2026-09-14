import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminActionType, VoteDecision } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { JwtAuthGuard, AdminGuard } from '../auth/auth.guard';

interface AuthedRequest {
  user: { id: string; isAdmin: boolean };
}

@UseGuards(JwtAuthGuard, AdminGuard) // every admin-governance route requires an authenticated admin
@Controller('admin')
export class AdminController {
  constructor(private admin: AdminService) {}

  @Post('propose')
  propose(
    @Req() req: AuthedRequest,
    @Body()
    body: {
      actionType: AdminActionType;
      payload: Record<string, unknown>;
      lockedYcAmount?: string;
      lockedPricePerYc?: string;
    },
  ) {
    return this.admin.propose(
      req.user.id,
      body.actionType,
      body.payload,
      body.lockedYcAmount ? new Decimal(body.lockedYcAmount) : undefined,
      body.lockedPricePerYc ? new Decimal(body.lockedPricePerYc) : undefined,
    );
  }

  @Post('vote')
  vote(@Req() req: AuthedRequest, @Body() body: { approvalId: string; decision: VoteDecision }) {
    // adminId is always the authenticated caller — you can't vote as someone else.
    return this.admin.vote(body.approvalId, req.user.id, body.decision);
  }
}
