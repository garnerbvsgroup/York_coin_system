import { Module } from '@nestjs/common';
import { EconomyService } from './economy.service';
import { EconomyController } from './economy.controller';

@Module({
  providers: [EconomyService],
  controllers: [EconomyController],
  exports: [EconomyService],
})
export class EconomyModule {}
