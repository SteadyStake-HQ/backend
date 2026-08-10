import { Module } from '@nestjs/common';
import { TokenListService } from './token-list.service';
import { TokenAdminController } from './token-admin.controller';
import { TokensController } from './tokens.controller';
import { TokenPriceController } from './token-price.controller';

@Module({
  controllers: [TokensController, TokenAdminController, TokenPriceController],
  providers: [TokenListService],
  exports: [TokenListService],
})
export class TokensModule {}
