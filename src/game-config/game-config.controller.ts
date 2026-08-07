import { Controller, Get, Header } from '@nestjs/common';
import { GameConfigService } from './game-config.service';

/**
 * The game's read of its own configuration (§21 Player APIs).
 *
 * Unguarded like the rest of the read-only surface: everything here is already visible to a player
 * who opens the Store or reads the SP rules in-game. The Echo Arena deployment fetches this on a
 * short cache, so a dashboard save reaches players within about a minute without a redeploy.
 */
@Controller('api/game')
export class GameConfigController {
  constructor(private readonly config: GameConfigService) {}

  /** GET /api/game/config — catalogue, settings and quests, merged over the shipped defaults. */
  @Get('config')
  // A shared 30s cache is the whole latency budget between saving on the dashboard and seeing it
  // in-game. Longer would make the dashboard feel broken; shorter puts the game's traffic on this.
  @Header('Cache-Control', 'public, max-age=30, s-maxage=30')
  gameConfig() {
    return this.config.publicConfig();
  }
}
