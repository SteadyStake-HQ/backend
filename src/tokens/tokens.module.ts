import { Module } from '@nestjs/common';
import { TokenListService } from './token-list.service';
import { TokenAdminController } from './token-admin.controller';
import { TokensController } from './tokens.controller';

@Module({
  controllers: [TokensController, TokenAdminController],
  providers: [TokenListService],
  exports: [TokenListService],
})
export class TokensModule {}
