import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { GameConfigService } from './game-config.service';

/**
 * Full operator control of Echo Arena's catalogue, rules and pass prices, behind the same
 * ADMIN_API_TOKEN as the other privileged endpoints.
 *
 * Everything here changes what players see on their next request — there is no publish step and no
 * deploy — so the service bounds-checks every field rather than trusting the dashboard.
 */
@Controller('api/admin/game')
@UseGuards(AdminTokenGuard)
export class GameConfigAdminController {
  constructor(private readonly config: GameConfigService) {}

  /** GET /api/admin/game/config — everything the Store and Settings pages render from. */
  @Get('config')
  adminConfig() {
    return this.config.adminConfig();
  }

  /* Catalogue ------------------------------------------------------------------------------- */

  /** POST /api/admin/game/catalog — add a hull, wake or round. */
  @Post('catalog')
  createItem(@Body() body: Record<string, unknown>) {
    return this.config.createItem(body ?? {});
  }

  /** PATCH /api/admin/game/catalog/:id — retitle, re-price, recolour, re-gate or disable an item. */
  @Patch('catalog/:id')
  updateItem(@Param('id', ParseIntPipe) id: number, @Body() body: Record<string, unknown>) {
    return this.config.updateItem(id, body ?? {});
  }

  /** DELETE /api/admin/game/catalog/:id — remove an item from the catalogue for good. */
  @Delete('catalog/:id')
  deleteItem(@Param('id', ParseIntPipe) id: number) {
    return this.config.deleteItem(id);
  }

  /** POST /api/admin/game/catalog/reorder { kind, ids } — set one shelf's order. */
  @Post('catalog/reorder')
  reorder(@Body() body: { kind?: unknown; ids?: unknown }) {
    return this.config.reorder(body?.kind, body?.ids);
  }

  /** POST /api/admin/game/catalog/reset — put every shipped item back as it ships. */
  @Post('catalog/reset')
  resetCatalog() {
    return this.config.resetCatalog();
  }

  /* Settings -------------------------------------------------------------------------------- */

  /** PATCH /api/admin/game/settings/:section — economy, arena, antiCheat or features. */
  @Patch('settings/:section')
  patchSettings(@Param('section') section: string, @Body() body: Record<string, unknown>) {
    return this.config.patchSettings(section, body ?? {});
  }

  /** POST /api/admin/game/settings/:section/reset — drop this section's overrides. */
  @Post('settings/:section/reset')
  resetSettings(@Param('section') section: string) {
    return this.config.resetSettings(section);
  }

  /* Quests ---------------------------------------------------------------------------------- */

  /** POST /api/admin/game/quests — create or update a daily quest, keyed on `key`. */
  @Post('quests')
  saveQuest(@Body() body: Record<string, unknown>) {
    return this.config.saveQuest(body ?? {});
  }

  /** DELETE /api/admin/game/quests/:key */
  @Delete('quests/:key')
  removeQuest(@Param('key') key: string) {
    return this.config.removeQuest(key);
  }

  /** POST /api/admin/game/quests/reset — restore the three shipped quests. */
  @Post('quests/reset')
  resetQuests() {
    return this.config.resetQuests();
  }

  /* Game Pass plans ------------------------------------------------------------------------- */

  /** GET /api/admin/game/pass-plans — the price table plus what each checkout contract charges. */
  @Get('pass-plans')
  passPlans() {
    return this.config.passPlans();
  }

  /**
   * POST /api/admin/game/pass-plans — create or update a plan, keyed on `id`.
   *
   * Price and duration must match what `setPlan()` put on every deployed checkout: the contract
   * asserts its own price was received, so a table that disagrees only makes buyers' transactions
   * revert. GET reports the drift per network.
   */
  @Post('pass-plans')
  savePassPlan(@Body() body: Record<string, unknown>) {
    return this.config.savePassPlan(body ?? {});
  }

  /** DELETE /api/admin/game/pass-plans/:id — drop the override row for a plan. */
  @Delete('pass-plans/:id')
  removePassPlan(@Param('id', ParseIntPipe) id: number) {
    return this.config.removePassPlan(id);
  }
}
