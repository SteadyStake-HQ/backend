import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createPublicClient, http } from 'viem';
import { getRpc } from '../config';
import { getChain } from '../run-executor';
import { PASS_CHECKOUT_ABI } from '../payments/pass-checkout-abi';
import { getPaymentNetworks } from '../supabase/payment-networks';
import { isSupabaseConfigured } from '../supabase/dca-plans-store';
import {
  createCatalogItem,
  deleteCatalogItem,
  deleteQuest,
  ensureGameConfigSeeded,
  getCatalogItem,
  listCatalog,
  listQuests,
  readSettingSections,
  reorderCatalog,
  resetCatalogToDefaults,
  resetQuestsToDefaults,
  settingsUpdatedAt,
  updateCatalogItem,
  upsertQuest,
  writeSettingSection,
  clearSettingSection,
  type CatalogRow,
} from '../supabase/game-config-store';
import {
  RETIRED_PLAN_IDS,
  deletePassPlan,
  ensurePassPlansSeeded,
  listPassPlans,
  upsertPassPlan,
  type PassPlanRow,
} from '../supabase/pass-plans-store';
import {
  COSMETIC_ART,
  COSMETIC_KINDS,
  DEFAULT_CATALOG,
  DEFAULT_QUESTS,
  DEFAULT_SETTINGS,
  isCosmeticKind,
  isCosmeticRequirement,
  isQuestMetric,
  QUEST_METRICS,
  type ArenaSettings,
  type AntiCheatSettings,
  type CatalogItem,
  type CosmeticKind,
  type EconomySettings,
  type FeatureFlags,
  type GameSettings,
  type QuestDefinition,
} from './game-defaults';

/** How long an on-chain plan read is reused before the drift check asks the chain again. */
const CHAIN_PLAN_CACHE_MS = 60_000;

/**
 * Everything about Echo Arena that an operator can change without a deploy: the Store catalogue,
 * the SP economy, the arena constants, the anti-cheat bounds, the feature flags, the daily quests
 * and the Game Pass price table.
 *
 * The game reads the merged result from `GET /api/game/config` and caches it briefly, so a save here
 * reaches players within about a minute. The game keeps a compiled copy of the same defaults and
 * falls back to it when this backend is unreachable — which is why every value in `game-defaults.ts`
 * has to stay in step with the game's own constants.
 *
 * **Validation is the point of this class.** These numbers gate a paid entitlement and an SP balance
 * that in turn gates wallet permissions, so an out-of-range save is a correctness bug, not a typo:
 * every field is bounds-checked here rather than trusted from the dashboard, and the two invariants
 * that would break the game outright — a kind with no wearable base item, and every play mode shut
 * at once — are refused rather than warned about.
 */
@Injectable()
export class GameConfigService implements OnModuleInit {
  private readonly logger = new Logger(GameConfigService.name);
  private ready: Promise<void> | null = null;
  private readonly chainPlans = new Map<
    number,
    { plans: Map<number, { durationSeconds: number; price: bigint; enabled: boolean }>; at: number }
  >();

  async onModuleInit(): Promise<void> {
    if (!isSupabaseConfigured()) {
      this.logger.warn(
        'SUPABASE_DB_URL is not set: Echo Arena game config is unavailable and the game will run on its compiled defaults.',
      );
      return;
    }
    // Seeding runs in the background: a slow first connection must not hold up the boot, and every
    // read awaits the same promise anyway.
    this.ensureReady().catch((error) => {
      this.logger.error(`Could not prepare the Echo Arena game config tables: ${(error as Error).message}`);
    });
  }

  /** Create and seed the tables once per process. Retried on the next call if it fails. */
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await ensureGameConfigSeeded();
        await ensurePassPlansSeeded();
      })().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  private requireDb(): void {
    if (!isSupabaseConfigured()) {
      throw new ServiceUnavailableException({
        ok: false,
        error: 'Game configuration is unavailable: SUPABASE_DB_URL is not configured on this backend.',
      });
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Reads                                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * What the game fetches: the enabled catalogue in shelf order, the merged settings, and the
   * enabled quests.
   *
   * Deliberately answers with the compiled defaults instead of an error when the database is not
   * configured. A game that cannot reach its config must keep running on the shipped rules — the
   * alternative is an outage in one backend closing a Store and a season in another deployment.
   */
  async publicConfig(): Promise<{
    ok: true;
    source: 'database' | 'defaults';
    updatedAt: string | null;
    settings: GameSettings;
    catalogue: Record<CosmeticKind, CatalogItem[]>;
    quests: QuestDefinition[];
  }> {
    if (!isSupabaseConfigured()) return this.defaultConfig();

    try {
      await this.ensureReady();
      const [items, sections, quests, updatedAt] = await Promise.all([
        listCatalog(true),
        readSettingSections(),
        listQuests(true),
        settingsUpdatedAt(),
      ]);

      return {
        ok: true,
        source: 'database',
        updatedAt: updatedAt ? updatedAt.toISOString() : null,
        settings: mergeSettings(sections),
        catalogue: groupByKind(items.length ? items : DEFAULT_CATALOG.filter((item) => item.enabled)),
        quests: quests.length
          ? quests
          : DEFAULT_QUESTS.filter((quest) => quest.enabled).map((q) => ({ ...q })),
      };
    } catch (error) {
      // A 500 here would be read by the game as "no answer" and fall back anyway — but it would also
      // be cached as a failure, and it hides the fact that we *do* know a good answer. Serving the
      // shipped rules keeps the arena on sane numbers through a database blip and says which they
      // are, which is what `source` is for.
      this.logger.error(
        `Serving the compiled Echo Arena defaults: the config tables could not be read (${(error as Error).message}).`,
      );
      return this.defaultConfig();
    }
  }

  /** The shipped rules, in the public payload's shape. */
  private defaultConfig(): Awaited<ReturnType<GameConfigService['publicConfig']>> {
    return {
      ok: true,
      source: 'defaults',
      updatedAt: null,
      settings: DEFAULT_SETTINGS,
      catalogue: groupByKind(DEFAULT_CATALOG.filter((item) => item.enabled)),
      quests: DEFAULT_QUESTS.filter((quest) => quest.enabled).map((quest) => ({ ...quest })),
    };
  }

  /**
   * The dashboard's view: everything the game sees plus what it does not — disabled rows, the
   * defaults to compare against, and the closed sets a form has to offer.
   */
  async adminConfig(): Promise<Record<string, unknown>> {
    this.requireDb();
    await this.ensureReady();
    const [items, sections, quests, updatedAt] = await Promise.all([
      listCatalog(false),
      readSettingSections(),
      listQuests(false),
      settingsUpdatedAt(),
    ]);

    const settings = mergeSettings(sections);
    return {
      ok: true,
      updatedAt: updatedAt ? updatedAt.toISOString() : null,
      settings,
      defaults: DEFAULT_SETTINGS,
      overriddenSections: Object.keys(sections),
      catalogue: groupByKind(items),
      quests,
      questDefaults: DEFAULT_QUESTS,
      meta: {
        kinds: COSMETIC_KINDS,
        art: COSMETIC_ART,
        questMetrics: QUEST_METRICS,
        // What the Store shelf falls back to per kind when a pilot's pick is locked or retired.
        baseItems: Object.fromEntries(
          COSMETIC_KINDS.map((kind) => [
            kind,
            items.find((item) => item.kind === kind && item.enabled && item.requires === 'base')?.itemId ?? null,
          ]),
        ),
      },
    };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Catalogue                                                                                 */
  /* ---------------------------------------------------------------------------------------- */

  async createItem(body: Record<string, unknown>): Promise<{ ok: true; item: CatalogRow }> {
    this.requireDb();
    await this.ensureReady();

    const kind = body.kind;
    if (!isCosmeticKind(kind)) {
      throw new BadRequestException({ ok: false, error: `kind must be one of ${COSMETIC_KINDS.join(', ')}.` });
    }

    const existing = await listCatalog(false);
    const itemId = readSlug(body.itemId, 'itemId');
    if (existing.some((item) => item.kind === kind && item.itemId === itemId)) {
      throw new BadRequestException({
        ok: false,
        error: `A ${kind} with the id "${itemId}" already exists. Ids are what a pilot's locker points at, so they have to be unique.`,
      });
    }

    const item: CatalogItem = {
      kind,
      itemId,
      ...this.readItemFields(body, kind, null),
      sortOrder:
        body.sortOrder === undefined
          ? nextSortOrder(existing.filter((row) => row.kind === kind))
          : readInt(body.sortOrder, 'sortOrder', 0, 100_000),
    };

    return { ok: true, item: await createCatalogItem(item) };
  }

  async updateItem(id: number, body: Record<string, unknown>): Promise<{ ok: true; item: CatalogRow }> {
    this.requireDb();
    await this.ensureReady();

    const current = await getCatalogItem(id);
    if (!current) throw new NotFoundException({ ok: false, error: `No catalogue item with id ${id}.` });

    const patch: Partial<Omit<CatalogItem, 'kind' | 'itemId'>> = {};
    const fields = this.readItemFields(body, current.kind, current);
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) (patch as Record<string, unknown>)[key] = value;
    }
    if (body.sortOrder !== undefined) patch.sortOrder = readInt(body.sortOrder, 'sortOrder', 0, 100_000);

    // The base item is the look every unentitled pilot — and every guest — flies. Losing the last
    // one for a kind would leave the game with nothing to fall back to, so it is refused here
    // rather than discovered as an invisible ship.
    const stillBase = (patch.requires ?? current.requires) === 'base';
    const stillEnabled = patch.enabled ?? current.enabled;
    if (current.requires === 'base' && current.enabled && !(stillBase && stillEnabled)) {
      await this.assertAnotherBaseItemExists(current);
    }

    const item = await updateCatalogItem(id, patch);
    if (!item) throw new NotFoundException({ ok: false, error: `No catalogue item with id ${id}.` });
    return { ok: true, item };
  }

  async deleteItem(id: number): Promise<{ ok: true; item: CatalogRow }> {
    this.requireDb();
    await this.ensureReady();

    const current = await getCatalogItem(id);
    if (!current) throw new NotFoundException({ ok: false, error: `No catalogue item with id ${id}.` });
    if (current.requires === 'base' && current.enabled) await this.assertAnotherBaseItemExists(current);

    const item = await deleteCatalogItem(id);
    if (!item) throw new NotFoundException({ ok: false, error: `No catalogue item with id ${id}.` });
    // Lockers still holding this item are not rewritten: the game already falls back to the base
    // look for an id it does not recognise, so a deleted item costs a pilot their selection and
    // nothing else.
    return { ok: true, item };
  }

  /** Refuse an edit that would leave `kind` with no enabled, unlocked item to fall back to. */
  private async assertAnotherBaseItemExists(current: CatalogRow): Promise<void> {
    const items = await listCatalog(false);
    const others = items.filter(
      (item) => item.kind === current.kind && item.id !== current.id && item.enabled && item.requires === 'base',
    );
    if (!others.length) {
      throw new BadRequestException({
        ok: false,
        error:
          `"${current.name}" is the only unlocked ${current.kind} left. Every pilot without a pass flies it, ` +
          'so add another item with the "Everyone" gate before retiring this one.',
      });
    }
  }

  async reorder(kind: unknown, ids: unknown): Promise<{ ok: true; kind: CosmeticKind }> {
    this.requireDb();
    await this.ensureReady();
    if (!isCosmeticKind(kind)) {
      throw new BadRequestException({ ok: false, error: `kind must be one of ${COSMETIC_KINDS.join(', ')}.` });
    }
    if (!Array.isArray(ids) || ids.some((id) => !Number.isInteger(Number(id)))) {
      throw new BadRequestException({ ok: false, error: 'ids must be an array of catalogue item ids.' });
    }
    await reorderCatalog(kind, ids.map((id) => Number(id)));
    return { ok: true, kind };
  }

  async resetCatalog(): Promise<{ ok: true; restored: number }> {
    this.requireDb();
    await this.ensureReady();
    return { ok: true, restored: await resetCatalogToDefaults() };
  }

  /**
   * Read and bounds-check the editable fields of a catalogue item.
   *
   * `current` null means a create, where every field is required; on an edit an absent field reads
   * back `undefined` and is left as it is.
   */
  private readItemFields(
    body: Record<string, unknown>,
    kind: CosmeticKind,
    current: CatalogRow | null,
  ): Omit<CatalogItem, 'kind' | 'itemId' | 'sortOrder'> {
    const art = pick(body.art, current?.art);
    if (!COSMETIC_ART[kind].includes(String(art))) {
      throw new BadRequestException({
        ok: false,
        error:
          `art must be one of ${COSMETIC_ART[kind].join(', ')} for a ${kind}. ` +
          'The drawing is compiled into the game client, so a new silhouette needs a game deploy — ' +
          'colours, price, name and gate do not.',
      });
    }

    const requires = pick(body.requires, current?.requires);
    if (!isCosmeticRequirement(requires)) {
      throw new BadRequestException({ ok: false, error: 'requires must be "base" (everyone) or "pass".' });
    }

    const spRequired = body.spRequired === undefined && current ? current.spRequired : readInt(body.spRequired ?? 0, 'spRequired', 0, 10_000_000);
    if (requires === 'base' && spRequired > 0) {
      throw new BadRequestException({
        ok: false,
        error:
          'An item gated to "Everyone" cannot also cost Steady Points — the two contradict, and the ' +
          'game would show it unlocked while refusing to equip it. Set the gate to "Game Pass" first.',
      });
    }

    return {
      art: String(art),
      name: readText(pick(body.name, current?.name), 'name', 1, 60),
      eyebrow: readText(pick(body.eyebrow, current?.eyebrow) ?? '', 'eyebrow', 0, 40),
      blurb: readText(pick(body.blurb, current?.blurb) ?? '', 'blurb', 0, 240),
      requires,
      spRequired,
      ink: readColor(pick(body.ink, current?.ink), 'ink'),
      accent: readColor(pick(body.accent, current?.accent), 'accent'),
      enabled: body.enabled === undefined ? current?.enabled ?? true : Boolean(body.enabled),
    };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Settings                                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * Save one settings section. The patch is merged over what is stored, validated as a whole, and
   * written as a whole — so a section is never half-valid, and a field left out keeps its value.
   */
  async patchSettings(section: string, body: Record<string, unknown>): Promise<{ ok: true; settings: GameSettings }> {
    this.requireDb();
    await this.ensureReady();

    const sections = await readSettingSections();
    const merged = mergeSettings(sections);
    let value: Record<string, unknown>;

    switch (section) {
      case 'economy':
        value = validateEconomy({ ...merged.economy, ...body }) as unknown as Record<string, unknown>;
        break;
      case 'arena':
        value = validateArena({ ...merged.arena, ...body }) as unknown as Record<string, unknown>;
        break;
      case 'antiCheat':
        value = validateAntiCheat({ ...merged.antiCheat, ...body }) as unknown as Record<string, unknown>;
        break;
      case 'features':
        value = validateFeatures({ ...merged.features, ...body }) as unknown as Record<string, unknown>;
        break;
      default:
        throw new BadRequestException({
          ok: false,
          error: 'section must be one of economy, arena, antiCheat, features.',
        });
    }

    await writeSettingSection(section, value);
    return { ok: true, settings: mergeSettings(await readSettingSections()) };
  }

  /** Drop a section's overrides so it falls back to what the backend shipped with. */
  async resetSettings(section: string): Promise<{ ok: true; settings: GameSettings }> {
    this.requireDb();
    await this.ensureReady();
    if (!['economy', 'arena', 'antiCheat', 'features'].includes(section)) {
      throw new BadRequestException({
        ok: false,
        error: 'section must be one of economy, arena, antiCheat, features.',
      });
    }
    await clearSettingSection(section);
    return { ok: true, settings: mergeSettings(await readSettingSections()) };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Quests                                                                                    */
  /* ---------------------------------------------------------------------------------------- */

  async saveQuest(body: Record<string, unknown>): Promise<{ ok: true; quest: QuestDefinition }> {
    this.requireDb();
    await this.ensureReady();

    const metric = body.metric;
    if (!isQuestMetric(metric)) {
      throw new BadRequestException({
        ok: false,
        error: `metric must be one of ${QUEST_METRICS.join(', ')} — those are the only counters the game keeps.`,
      });
    }

    const existing = await listQuests(false);
    const key = readSlug(body.key, 'key');
    const quest: QuestDefinition = {
      key,
      label: readText(body.label, 'label', 1, 40),
      metric,
      target: readInt(body.target, 'target', 1, 1_000_000),
      // A quest reward is paid outside the normal-mode sub-cap, so it is the one SP source a player
      // can collect without spending a verified run. Kept small on purpose.
      reward: readInt(body.reward, 'reward', 0, 500),
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      sortOrder:
        body.sortOrder === undefined
          ? existing.find((q) => q.key === key)?.sortOrder ?? nextSortOrder(existing)
          : readInt(body.sortOrder, 'sortOrder', 0, 100_000),
    };
    return { ok: true, quest: await upsertQuest(quest) };
  }

  async removeQuest(key: string): Promise<{ ok: true }> {
    this.requireDb();
    await this.ensureReady();
    if (!(await deleteQuest(key))) {
      throw new NotFoundException({ ok: false, error: `No quest with the key "${key}".` });
    }
    return { ok: true };
  }

  async resetQuests(): Promise<{ ok: true; quests: QuestDefinition[] }> {
    this.requireDb();
    await this.ensureReady();
    await resetQuestsToDefaults();
    return { ok: true, quests: await listQuests(false) };
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Game Pass plans                                                                           */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * The plan table with, per enabled payment network, what that network's checkout contract will
   * actually charge.
   *
   * The contract is the authority: `buyPass` asserts the treasury received exactly *its* price, so a
   * row here that disagrees does not re-price anything — it makes the buyer's transaction revert
   * after they have already paid gas to approve. That is what `drift` is for.
   */
  async passPlans(): Promise<Record<string, unknown>> {
    this.requireDb();
    await this.ensureReady();
    const plans = await listPassPlans(false);
    const networks = await getPaymentNetworks(true);

    const onChain = await Promise.all(
      networks.map(async (network) => {
        const chainPlans = await this.readChainPlans(network.chainId, network.checkoutContract, plans);
        return {
          chainId: network.chainId,
          checkoutContract: network.checkoutContract,
          stablecoinSymbol: network.stablecoinSymbol,
          stablecoinDecimals: network.stablecoinDecimals,
          readable: chainPlans !== null,
          plans: plans.map((plan) => {
            const found = chainPlans?.get(plan.id);
            const expected = centsToAtomic(plan.priceCents, network.stablecoinDecimals);
            return {
              id: plan.id,
              enabledOnChain: found?.enabled ?? null,
              priceOnChain: found ? found.price.toString() : null,
              priceExpected: expected === null ? null : expected.toString(),
              durationOnChain: found?.durationSeconds ?? null,
              drift: !found
                ? null
                : {
                    price: expected !== null && found.price !== expected,
                    duration: found.durationSeconds !== plan.durationSeconds,
                  },
            };
          }),
        };
      }),
    );

    return { ok: true, plans, networks: onChain, retiredIds: RETIRED_PLAN_IDS };
  }

  async savePassPlan(body: Record<string, unknown>): Promise<{ ok: true; plan: PassPlanRow }> {
    this.requireDb();
    await this.ensureReady();

    const id = readInt(body.id, 'id', 1, 255);
    const plans = await listPassPlans(false);
    if (RETIRED_PLAN_IDS.includes(id) && !plans.some((plan) => plan.id === id)) {
      throw new BadRequestException({
        ok: false,
        error:
          `Plan id ${id} is retired and cannot be reused. It was a one-cent test tier that bought the ` +
          'full pass entitlement, and any checkout that ever had it seeded would sell a new plan ' +
          'under that id at the old price. Pick an unused id.',
      });
    }

    const plan = await upsertPassPlan({
      id,
      key: readSlug(body.key, 'key'),
      label: readText(body.label, 'label', 1, 40),
      durationSeconds: readInt(body.durationSeconds, 'durationSeconds', 60, 3 * 365 * 24 * 60 * 60),
      // Whole US cents: the atomic amount is derived per network from the stablecoin's decimals, so
      // the displayed dollar price is the same number on every chain (§5.1).
      priceCents: readInt(body.priceCents, 'priceCents', 1, 10_000_000),
      enabled: body.enabled === undefined ? true : Boolean(body.enabled),
      sortOrder:
        body.sortOrder === undefined
          ? plans.find((p) => p.id === id)?.sortOrder ?? nextSortOrder(plans)
          : readInt(body.sortOrder, 'sortOrder', 0, 100_000),
    });
    this.chainPlans.clear();
    return { ok: true, plan };
  }

  async removePassPlan(id: number): Promise<{ ok: true }> {
    this.requireDb();
    await this.ensureReady();
    if (!(await deletePassPlan(id))) {
      throw new NotFoundException({ ok: false, error: `No pass plan with id ${id}.` });
    }
    this.chainPlans.clear();
    return { ok: true };
  }

  /** `plans(planId)` for every id in the table, or null when the chain cannot be read. */
  private async readChainPlans(
    chainId: number,
    checkout: string,
    plans: PassPlanRow[],
  ): Promise<Map<number, { durationSeconds: number; price: bigint; enabled: boolean }> | null> {
    const cached = this.chainPlans.get(chainId);
    if (cached && Date.now() - cached.at < CHAIN_PLAN_CACHE_MS) return cached.plans;

    const chain = getChain(chainId);
    const rpc = getRpc(chainId);
    if (!chain || !rpc) return null;

    try {
      const client = createPublicClient({ chain, transport: http(rpc) });
      const found = new Map<number, { durationSeconds: number; price: bigint; enabled: boolean }>();
      for (const plan of plans) {
        const [durationSeconds, price, enabled] = await client.readContract({
          address: checkout as `0x${string}`,
          abi: PASS_CHECKOUT_ABI,
          functionName: 'plans',
          args: [plan.id],
        });
        found.set(plan.id, { durationSeconds: Number(durationSeconds), price, enabled });
      }
      this.chainPlans.set(chainId, { plans: found, at: Date.now() });
      return found;
    } catch (error) {
      this.logger.warn(
        `Could not read pass plans from ${checkout} on chain ${chainId}: ${(error as Error).message}`,
      );
      return null;
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Merging and validation
 * --------------------------------------------------------------------------------------------- */

/** Stored sections over the shipped defaults, so a key added by a later deploy always has a value. */
export function mergeSettings(sections: Record<string, Record<string, unknown>>): GameSettings {
  return {
    economy: validateEconomy({ ...DEFAULT_SETTINGS.economy, ...(sections.economy ?? {}) }),
    arena: validateArena({ ...DEFAULT_SETTINGS.arena, ...(sections.arena ?? {}) }),
    antiCheat: validateAntiCheat({ ...DEFAULT_SETTINGS.antiCheat, ...(sections.antiCheat ?? {}) }),
    features: validateFeatures({ ...DEFAULT_SETTINGS.features, ...(sections.features ?? {}) }),
  };
}

function validateEconomy(input: Record<string, unknown>): EconomySettings {
  const freeDailySpCap = readInt(input.freeDailySpCap, 'freeDailySpCap', 0, 1_000_000);
  const boostedDailySpCap = readInt(input.boostedDailySpCap, 'boostedDailySpCap', 0, 1_000_000);
  if (boostedDailySpCap < freeDailySpCap) {
    throw new BadRequestException({
      ok: false,
      error:
        'The boosted daily SP cap cannot be below the free one — a pass would then lower the ceiling ' +
        'it is sold on raising.',
    });
  }

  const tiers = input.skillBonusTiers;
  if (!Array.isArray(tiers) || tiers.length > 8) {
    throw new BadRequestException({ ok: false, error: 'skillBonusTiers must be an array of at most 8 tiers.' });
  }
  const skillBonusTiers = tiers
    .map((tier) => {
      const row = (tier ?? {}) as Record<string, unknown>;
      return {
        score: readInt(row.score, 'skillBonusTiers[].score', 0, 100_000_000),
        bonus: readInt(row.bonus, 'skillBonusTiers[].bonus', 0, 1_000),
      };
    })
    // Ascending by score, so the game can read the richest matching tier off the end of the list.
    .sort((a, b) => a.score - b.score);

  return {
    freeMultiplierPct: readInt(input.freeMultiplierPct, 'freeMultiplierPct', 0, 10_000),
    passMultiplierPct: readInt(input.passMultiplierPct, 'passMultiplierPct', 0, 10_000),
    rankedAttemptsPerDay: readInt(input.rankedAttemptsPerDay, 'rankedAttemptsPerDay', 0, 1_000),
    freeDailySpCap,
    boostedDailySpCap,
    normalDailySpCap: readInt(input.normalDailySpCap, 'normalDailySpCap', 0, 1_000_000),
    cyclePointsCap: readInt(input.cyclePointsCap, 'cyclePointsCap', 0, 10_000),
    combatKillsPerPoint: readInt(input.combatKillsPerPoint, 'combatKillsPerPoint', 1, 10_000),
    combatPointsCap: readInt(input.combatPointsCap, 'combatPointsCap', 0, 10_000),
    skillBonusTiers,
    baseSpCap: readInt(input.baseSpCap, 'baseSpCap', 0, 100_000),
  };
}

function validateArena(input: Record<string, unknown>): ArenaSettings {
  return {
    baseCycleLength: readInt(input.baseCycleLength, 'baseCycleLength', 1, 3_600),
    echoDestroyBonus: readInt(input.echoDestroyBonus, 'echoDestroyBonus', 0, 1_000_000),
    maxEchoHealth: readInt(input.maxEchoHealth, 'maxEchoHealth', 1, 1_000),
  };
}

function validateAntiCheat(input: Record<string, unknown>): AntiCheatSettings {
  return {
    maxCycle: readInt(input.maxCycle, 'maxCycle', 1, 100_000),
    maxEchoes: readInt(input.maxEchoes, 'maxEchoes', 1, 100_000),
    // Below 100 the ceiling would sit under the score an honest run can reach, so every good run is
    // rejected as fabricated. That is the expensive direction of this knob.
    scoreCeilingSlackPct: readInt(input.scoreCeilingSlackPct, 'scoreCeilingSlackPct', 100, 100_000),
    scoreCeilingFlat: readInt(input.scoreCeilingFlat, 'scoreCeilingFlat', 0, 100_000_000),
    survivalSlackSeconds: readInt(input.survivalSlackSeconds, 'survivalSlackSeconds', 0, 3_600),
  };
}

function validateFeatures(input: Record<string, unknown>): FeatureFlags {
  const features: FeatureFlags = {
    storeEnabled: Boolean(input.storeEnabled),
    rankedEnabled: Boolean(input.rankedEnabled),
    openVerifiedEnabled: Boolean(input.openVerifiedEnabled),
    normalEnabled: Boolean(input.normalEnabled),
    questsEnabled: Boolean(input.questsEnabled),
    leaderboardEnabled: Boolean(input.leaderboardEnabled),
    maintenanceMode: Boolean(input.maintenanceMode),
    maintenanceMessage: readText(input.maintenanceMessage ?? '', 'maintenanceMessage', 0, 240),
  };

  // Normal is the mode every closed window falls back to, so shutting all three leaves a signed-in
  // wallet with nothing playable at all. Maintenance mode is the switch for that, and it says so.
  if (!features.normalEnabled && !features.rankedEnabled && !features.openVerifiedEnabled) {
    throw new BadRequestException({
      ok: false,
      error:
        'That would leave no playable mode. Turn on maintenance mode instead — it closes play with a ' +
        'message players can read, rather than an arena that refuses every run without saying why.',
    });
  }
  if (features.maintenanceMode && !features.maintenanceMessage.trim()) {
    throw new BadRequestException({
      ok: false,
      error: 'Maintenance mode needs a message: it is the only thing a player will be shown.',
    });
  }
  return features;
}

/* ------------------------------------------------------------------------------------------------
 * Field readers
 * --------------------------------------------------------------------------------------------- */

function pick<T>(value: unknown, fallback: T | undefined): unknown {
  return value === undefined ? fallback : value;
}

function readInt(value: unknown, field: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new BadRequestException({ ok: false, error: `${field} must be a whole number.` });
  }
  if (parsed < min || parsed > max) {
    throw new BadRequestException({
      ok: false,
      error: `${field} must be between ${min.toLocaleString()} and ${max.toLocaleString()}.`,
    });
  }
  return parsed;
}

function readText(value: unknown, field: string, min: number, max: number): string {
  const text = String(value ?? '').trim();
  if (text.length < min) throw new BadRequestException({ ok: false, error: `${field} is required.` });
  if (text.length > max) {
    throw new BadRequestException({ ok: false, error: `${field} must be ${max} characters or fewer.` });
  }
  return text;
}

/** A stable, url-safe key. Slugs are stored in player rows, so they stay boring on purpose. */
function readSlug(value: unknown, field: string): string {
  const text = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,39}$/.test(text)) {
    throw new BadRequestException({
      ok: false,
      error: `${field} must be 2–40 characters of lowercase letters, digits, "-" or "_", starting with a letter or digit.`,
    });
  }
  return text;
}

function readColor(value: unknown, field: string): string {
  const text = String(value ?? '').trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(text)) {
    throw new BadRequestException({ ok: false, error: `${field} must be a six-digit hex colour such as #ff624f.` });
  }
  return text.toLowerCase();
}

function nextSortOrder(rows: Array<{ sortOrder: number }>): number {
  return rows.reduce((max, row) => Math.max(max, row.sortOrder), 0) + 10;
}

function groupByKind<T extends { kind: CosmeticKind }>(items: readonly T[]): Record<CosmeticKind, T[]> {
  const out = { ship: [] as T[], trail: [] as T[], bolt: [] as T[] };
  for (const item of items) out[item.kind].push(item);
  return out;
}

/**
 * A plan's price in the stablecoin's atomic units — the number the contract holds. Null when the
 * token has fewer than two decimals, where whole cents cannot be represented at all.
 */
function centsToAtomic(priceCents: number, decimals: number): bigint | null {
  if (decimals < 2) return null;
  return BigInt(priceCents) * 10n ** BigInt(decimals - 2);
}
