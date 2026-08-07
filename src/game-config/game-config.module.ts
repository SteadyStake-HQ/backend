import { Module } from '@nestjs/common';
import { GameConfigController } from './game-config.controller';
import { GameConfigAdminController } from './game-config-admin.controller';
import { GameConfigService } from './game-config.service';

/**
 * Echo Arena's live configuration: the Store catalogue, the SP economy, the arena constants, the
 * anti-cheat bounds, the feature flags, the daily quests and the Game Pass price table.
 *
 * The season system next door owns *when* play is rated; this owns *what the rules are* while it is.
 * Both are edited from the Echo Arena dashboard and both are read by the game over HTTP.
 */
@Module({
  controllers: [GameConfigController, GameConfigAdminController],
  providers: [GameConfigService],
  exports: [GameConfigService],
})
export class GameConfigModule {}
