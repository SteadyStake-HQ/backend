import { Module } from '@nestjs/common';
import { PlayersAdminController } from './players-admin.controller';
import { PlayersService } from './players.service';

/**
 * Echo Arena play records (§17). A read-only operator view over the game's player, run and Steady
 * Points tables, which the game writes into the database both apps share.
 */
@Module({
  controllers: [PlayersAdminController],
  providers: [PlayersService],
  exports: [PlayersService],
})
export class PlayersModule {}
