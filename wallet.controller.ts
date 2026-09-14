import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import { WalletService } from './wallet.service';
import { JwtAuthGuard, AdminGuard } from '../auth/auth.guard';

interface AuthedRequest {
  user: { id: string; isAdmin: boolean };
}

@UseGuards(JwtAuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(private wallet: WalletService) {}

  // Users can only ever see their own wallet/history through these routes —
  // there is no userId path param, so there's nothing to authorize per-request.
  @Get('me')
  getMyBalance(@Req() req: AuthedRequest) {
    return this.wallet.getBalance(req.user.id);
  }

  @Get('me/history')
  getMyHistory(@Req() req: AuthedRequest) {
    return this.wallet.getHistory(req.user.id);
  }

  @UseGuards(AdminGuard)
  @Get('_debug/reconcile')
  reconcile() {
    return this.wallet.reconcileFromLedger();
  }
}
