import { Module } from '@nestjs/common';
import { PrismaModule } from './prisma/prisma.module';
import { EconomyModule } from './economy/economy.module';
import { AdminModule } from './admin/admin.module';
import { WalletModule } from './wallet/wallet.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule, EconomyModule, AdminModule, WalletModule],
})
export class AppModule {}
