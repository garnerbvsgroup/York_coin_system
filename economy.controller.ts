import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/library';
import { EconomyService } from './economy.service';
import { JwtAuthGuard, AdminGuard } from '../auth/auth.guard';

interface AuthedRequest {
  user: { id: string; isAdmin: boolean };
}

@UseGuards(JwtAuthGuard)
@Controller('economy')
export class EconomyController {
  constructor(private economy: EconomyService) {}

  @Post('buy')
  buy(@Req() req: AuthedRequest, @Body() body: { ycAmount: string }) {
    // Buys for yourself only — userId comes from the verified token, never the body.
    return this.economy.buy(req.user.id, new Decimal(body.ycAmount));
  }

  @UseGuards(AdminGuard)
  @Post('admin-grant')
  adminGrant(
    @Req() req: AuthedRequest,
    @Body()
    body: {
      userId: string;
      ycAmount: string;
      confirmedRealDeposit: boolean;
      approvedAdminApprovalId?: string;
    },
  ) {
    return this.economy.adminGrant(
      req.user.id, // adminId — verified admin from the token, not client-supplied
      body.userId,
      new Decimal(body.ycAmount),
      body.confirmedRealDeposit,
      body.approvedAdminApprovalId,
    );
  }

  @Post('transfer')
  transfer(@Req() req: AuthedRequest, @Body() body: { toUserId: string; ycAmount: string }) {
    // fromUserId is always the authenticated caller — you can only transfer your own coins.
    return this.economy.transfer(req.user.id, body.toUserId, new Decimal(body.ycAmount));
  }

  @Post('burn')
  burn(@Req() req: AuthedRequest, @Body() body: { ycAmount: string }) {
    return this.economy.burn(req.user.id, new Decimal(body.ycAmount));
  }

  @Post('store-purchase')
  storePurchase(@Req() req: AuthedRequest, @Body() body: { storeItemId: string }) {
    return this.economy.storePurchase(req.user.id, body.storeItemId);
  }

  @Post('redeem')
  redeem(@Req() req: AuthedRequest, @Body() body: { ycAmount: string; payoutMethod: 'CASH' | 'CHECK' }) {
    return this.economy.redeem(req.user.id, new Decimal(body.ycAmount), body.payoutMethod);
  }
}
