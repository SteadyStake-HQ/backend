/**
 * The shipped Echo Arena catalogue and rule set, as data.
 *
 * These are the values the game had hard-coded in `lib/cosmetics.ts`, `lib/steady-points.ts` and
 * `lib/arena-rules.ts` before the dashboard owned them. They serve three purposes here:
 *
 * 1. **Seed.** An empty database is filled with exactly this, so turning the feature on changes
 *    nothing a player can see.
 * 2. **Reset.** Every dashboard section has a "restore defaults" that writes these back, so an
 *    operator can always get out of a bad edit without a database console.
 * 3. **Floor.** Every read merges the stored settings over these, so a key added by a later deploy
 *    has a value on a database written before it existed.
 *
 * The game keeps its own copy of the same numbers as an offline fallback — it has to, since it must
 * still run when this backend is unreachable — but from here on *this* is the source of truth and
 * the game's copy is only what it falls back to. When you change a default here, change the game's
 * fallback in the same breath or a backend outage will silently re-price the Store.
 */

/* ------------------------------------------------------------------------------------------------
 * Catalogue
 * --------------------------------------------------------------------------------------------- */

export type CosmeticKind = 'ship' | 'trail' | 'bolt';

export const COSMETIC_KINDS: readonly CosmeticKind[] = ['ship', 'trail', 'bolt'];

export function isCosmeticKind(value: unknown): value is CosmeticKind {
  return COSMETIC_KINDS.includes(value as CosmeticKind);
}

/**
 * The drawing an item uses, per kind.
 *
 * An item's `id` is free-form — an operator may add "Delta Lance (Crimson)" and sell it — but the
 * *art* is a canvas routine compiled into the game client, so it can only ever be one of these. That
 * split is what makes the catalogue editable at all: colours, price, name, gate and availability are
 * data, and only the silhouette needs a deploy. A new silhouette means new art keys added here and
 * new `draw*` functions in the game's `app/cosmetics-render.ts`, together.
 */
export const COSMETIC_ART: Record<CosmeticKind, readonly string[]> = {
  ship: ['standard', 'delta', 'halo', 'monarch', 'prism', 'seraph'],
  trail: ['ember', 'ribbon', 'bloom', 'aurora', 'shards', 'nebula'],
  bolt: ['spark', 'lance', 'pulse', 'blossom', 'facet', 'comet'],
};

/** What a wallet must hold to fly an item: everyone, or an in-date Game Pass. */
export type CosmeticRequirement = 'base' | 'pass';

export const COSMETIC_REQUIREMENTS: readonly CosmeticRequirement[] = ['base', 'pass'];

export function isCosmeticRequirement(value: unknown): value is CosmeticRequirement {
  return COSMETIC_REQUIREMENTS.includes(value as CosmeticRequirement);
}

export interface CatalogItem {
  kind: CosmeticKind;
  /** Stable slug. This is what a player's locker row stores, so renaming one re-bases every locker. */
  itemId: string;
  /** Which compiled drawing the client uses. One of `COSMETIC_ART[kind]`. */
  art: string;
  name: string;
  eyebrow: string;
  blurb: string;
  requires: CosmeticRequirement;
  /** The price, in verified Steady Points banked on top of the pass. 0 = the pass alone is enough. */
  spRequired: number;
  /** Hull/wake/round body colour. */
  ink: string;
  /** The lit colour: cockpits, pods, sparks, the far end of a gradient. */
  accent: string;
  /** Off hides the item from the Store and from the game entirely; lockers keep their row. */
  enabled: boolean;
  /** Ascending. Decides the order of the Store shelf. */
  sortOrder: number;
}

/** The two SP steps the shipped prestige items are priced at. */
export const SP_STEP_RARE = 400;
export const SP_STEP_PRESTIGE = 1_200;

export const DEFAULT_CATALOG: readonly CatalogItem[] = [
  // Hulls
  {
    kind: 'ship',
    itemId: 'standard',
    art: 'standard',
    name: 'Scout Mk I',
    eyebrow: 'Standard issue',
    blurb: 'The hull every pilot starts in. Grows a piece with every upgrade card.',
    requires: 'base',
    spRequired: 0,
    ink: '#ff624f',
    accent: '#f5dca4',
    enabled: true,
    sortOrder: 10,
  },
  {
    kind: 'ship',
    itemId: 'delta',
    art: 'delta',
    name: 'Delta Lance',
    eyebrow: 'Interceptor',
    blurb: 'A narrow dart with forward canards and twin outriggers. Reads as speed.',
    requires: 'pass',
    spRequired: 0,
    ink: '#4d9dff',
    accent: '#d8f2ff',
    enabled: true,
    sortOrder: 20,
  },
  {
    kind: 'ship',
    itemId: 'halo',
    art: 'halo',
    name: 'Halo Core',
    eyebrow: 'Orbital',
    blurb: 'A teardrop core suspended inside a turning ring of nodes.',
    requires: 'pass',
    spRequired: 0,
    ink: '#17c2a4',
    accent: '#fdf3df',
    enabled: true,
    sortOrder: 30,
  },
  {
    kind: 'ship',
    itemId: 'monarch',
    art: 'monarch',
    name: 'Monarch',
    eyebrow: 'Broad wing',
    blurb: 'Scalloped wings with printed eye-spots and a split streamer tail.',
    requires: 'pass',
    spRequired: 0,
    ink: '#e0508f',
    accent: '#ffe0a8',
    enabled: true,
    sortOrder: 40,
  },
  {
    kind: 'ship',
    itemId: 'prism',
    art: 'prism',
    name: 'Prism Drive',
    eyebrow: 'Refractor',
    blurb: 'A faceted crystal hull with shards held in orbit around a turning gem.',
    requires: 'pass',
    spRequired: SP_STEP_RARE,
    ink: '#9d7bff',
    accent: '#eafbff',
    enabled: true,
    sortOrder: 50,
  },
  {
    kind: 'ship',
    itemId: 'seraph',
    art: 'seraph',
    name: 'Seraph',
    eyebrow: 'Ceremonial',
    blurb: 'Three pairs of light-feathers and a halo. The last thing an echo sees.',
    requires: 'pass',
    spRequired: SP_STEP_PRESTIGE,
    ink: '#ffb648',
    accent: '#fff6dd',
    enabled: true,
    sortOrder: 60,
  },

  // Wakes
  {
    kind: 'trail',
    itemId: 'ember',
    art: 'ember',
    name: 'Ember Wake',
    eyebrow: 'Standard issue',
    blurb: 'The tapered burn every hull leaves behind it.',
    requires: 'base',
    spRequired: 0,
    ink: '#ff5746',
    accent: '#f5dca4',
    enabled: true,
    sortOrder: 10,
  },
  {
    kind: 'trail',
    itemId: 'ribbon',
    art: 'ribbon',
    name: 'Silk Ribbon',
    eyebrow: 'Braided',
    blurb: 'Two ribbons weaving around the flight path, crossing as you turn.',
    requires: 'pass',
    spRequired: 0,
    ink: '#4d9dff',
    accent: '#c9ecff',
    enabled: true,
    sortOrder: 20,
  },
  {
    kind: 'trail',
    itemId: 'bloom',
    art: 'bloom',
    name: 'Star Bloom',
    eyebrow: 'Scattering',
    blurb: 'Four-point stars shed along the wake, turning as they fade.',
    requires: 'pass',
    spRequired: 0,
    ink: '#ffd166',
    accent: '#fff6dd',
    enabled: true,
    sortOrder: 30,
  },
  {
    kind: 'trail',
    itemId: 'aurora',
    art: 'aurora',
    name: 'Aurora Veil',
    eyebrow: 'Soft band',
    blurb: 'A wide two-tone veil that shifts colour from tail to nose.',
    requires: 'pass',
    spRequired: 0,
    ink: '#17c2a4',
    accent: '#8f7bff',
    enabled: true,
    sortOrder: 40,
  },
  {
    kind: 'trail',
    itemId: 'shards',
    art: 'shards',
    name: 'Prism Shards',
    eyebrow: 'Refractor',
    blurb: 'Chevrons stamped across the wake, splitting wider the faster you fly.',
    requires: 'pass',
    spRequired: SP_STEP_RARE,
    ink: '#9d7bff',
    accent: '#eafbff',
    enabled: true,
    sortOrder: 50,
  },
  {
    kind: 'trail',
    itemId: 'nebula',
    art: 'nebula',
    name: 'Nebula Bloom',
    eyebrow: 'Ceremonial',
    blurb: 'Glowing clouds that pool behind the hull and burn off slowly.',
    requires: 'pass',
    spRequired: SP_STEP_PRESTIGE,
    ink: '#ff7ad9',
    accent: '#ffe9ff',
    enabled: true,
    sortOrder: 60,
  },

  // Rounds
  {
    kind: 'bolt',
    itemId: 'spark',
    art: 'spark',
    name: 'Spark Round',
    eyebrow: 'Standard issue',
    blurb: 'The tapered round the gun has always fired, with a cream-hot head.',
    requires: 'base',
    spRequired: 0,
    ink: '#ff765c',
    accent: '#f5dca4',
    enabled: true,
    sortOrder: 10,
  },
  {
    kind: 'bolt',
    itemId: 'lance',
    art: 'lance',
    name: 'Lance Round',
    eyebrow: 'Kinetic',
    blurb: 'A long needle with a lit tip and two barbs raked back along the shaft.',
    requires: 'pass',
    spRequired: 0,
    ink: '#4d9dff',
    accent: '#d8f2ff',
    enabled: true,
    sortOrder: 20,
  },
  {
    kind: 'bolt',
    itemId: 'pulse',
    art: 'pulse',
    name: 'Pulse Round',
    eyebrow: 'Resonant',
    blurb: 'A bright core inside rings that beat outward as the round travels.',
    requires: 'pass',
    spRequired: 0,
    ink: '#17c2a4',
    accent: '#eafff8',
    enabled: true,
    sortOrder: 30,
  },
  {
    kind: 'bolt',
    itemId: 'blossom',
    art: 'blossom',
    name: 'Blossom Round',
    eyebrow: 'Scattering',
    blurb: 'A four-petal round that turns as it flies and sheds petals behind it.',
    requires: 'pass',
    spRequired: 0,
    ink: '#ffd166',
    accent: '#fff6dd',
    enabled: true,
    sortOrder: 40,
  },
  {
    kind: 'bolt',
    itemId: 'facet',
    art: 'facet',
    name: 'Facet Round',
    eyebrow: 'Refractor',
    blurb: 'A cut chevron head trailed by two split ghosts of itself.',
    requires: 'pass',
    spRequired: SP_STEP_RARE,
    ink: '#9d7bff',
    accent: '#eafbff',
    enabled: true,
    sortOrder: 50,
  },
  {
    kind: 'bolt',
    itemId: 'comet',
    art: 'comet',
    name: 'Comet Round',
    eyebrow: 'Ceremonial',
    blurb: 'A burning head dragging a plume that pools and cools behind it.',
    requires: 'pass',
    spRequired: SP_STEP_PRESTIGE,
    ink: '#ffa63d',
    accent: '#fff2cf',
    enabled: true,
    sortOrder: 60,
  },
];

/* ------------------------------------------------------------------------------------------------
 * Settings
 * --------------------------------------------------------------------------------------------- */

/** §8 Steady Points economics. Every number here is issued per wallet per UTC day. */
export interface EconomySettings {
  /** SP multiplier for a wallet with no pass, as a percentage (100 = 1.0x). */
  freeMultiplierPct: number;
  /** SP multiplier for an in-date Game Pass. Stacks multiplicatively with the season's. */
  passMultiplierPct: number;
  /** Ranked attempts per UTC day. The pass deliberately does not change this (§1.9). */
  rankedAttemptsPerDay: number;
  /** Daily SP ceiling with no live season and no pass. */
  freeDailySpCap: number;
  /** Daily SP ceiling while a season is live *or* the pass is in date. */
  boostedDailySpCap: number;
  /**
   * How much of a day's SP unlimited `normal` play may produce while a season is live. Between
   * seasons there is no sub-cap at all — see the game's `normalSpCapFor`.
   */
  normalDailySpCap: number;
  /** §8.2 base SP formula. */
  cyclePointsCap: number;
  /** Kills per Combat Point. 2 = one point per two echoes destroyed. */
  combatKillsPerPoint: number;
  combatPointsCap: number;
  /** Score thresholds for the skill bonus, richest first is not required — the service sorts. */
  skillBonusTiers: Array<{ score: number; bonus: number }>;
  /** Ceiling on Cycle + Combat + Skill for one run. */
  baseSpCap: number;
}

export interface ArenaSettings {
  /** Seconds in cycle 1; every later cycle is one second longer. */
  baseCycleLength: number;
  /** Score for destroying an echo, before the per-echo and health terms. */
  echoDestroyBonus: number;
  maxEchoHealth: number;
}

/** The bounds `describeImplausibleRun` rejects a submitted run against. */
export interface AntiCheatSettings {
  maxCycle: number;
  maxEchoes: number;
  /** Headroom multiplier on the computed score ceiling, as a percentage (150 = 1.5x). */
  scoreCeilingSlackPct: number;
  /** Flat headroom added on top of the multiplier, in points. */
  scoreCeilingFlat: number;
  /** Seconds of slack allowed between the reported cycle and the reported survival time. */
  survivalSlackSeconds: number;
}

/**
 * Kill switches. Each one shuts a whole feature off for every player without a deploy — what you
 * reach for when something is being abused mid-season and the fix is not ready.
 */
export interface FeatureFlags {
  /** Off closes the Store outright: no cards, no equipping, everyone flies the base look. */
  storeEnabled: boolean;
  rankedEnabled: boolean;
  openVerifiedEnabled: boolean;
  /** Off leaves nothing playable for a signed-in wallet; refuse to set it and the others off. */
  normalEnabled: boolean;
  questsEnabled: boolean;
  leaderboardEnabled: boolean;
  /** On refuses every ticket and every submit with `maintenanceMessage`. Reads keep working. */
  maintenanceMode: boolean;
  maintenanceMessage: string;
}

export interface GameSettings {
  economy: EconomySettings;
  arena: ArenaSettings;
  antiCheat: AntiCheatSettings;
  features: FeatureFlags;
}

export const DEFAULT_SETTINGS: GameSettings = {
  economy: {
    freeMultiplierPct: 100,
    passMultiplierPct: 150,
    rankedAttemptsPerDay: 3,
    freeDailySpCap: 100,
    boostedDailySpCap: 1_000,
    normalDailySpCap: 100,
    cyclePointsCap: 8,
    combatKillsPerPoint: 2,
    combatPointsCap: 4,
    skillBonusTiers: [
      { score: 2_000, bonus: 2 },
      { score: 5_000, bonus: 4 },
    ],
    baseSpCap: 16,
  },
  arena: {
    baseCycleLength: 15,
    echoDestroyBonus: 300,
    maxEchoHealth: 9,
  },
  antiCheat: {
    maxCycle: 500,
    maxEchoes: 500,
    scoreCeilingSlackPct: 150,
    scoreCeilingFlat: 5_000,
    survivalSlackSeconds: 1,
  },
  features: {
    storeEnabled: true,
    rankedEnabled: true,
    openVerifiedEnabled: true,
    normalEnabled: true,
    questsEnabled: true,
    leaderboardEnabled: true,
    maintenanceMode: false,
    maintenanceMessage: 'Echo Arena is down for maintenance. Scores are safe — try again shortly.',
  },
};

/* ------------------------------------------------------------------------------------------------
 * Quests
 * --------------------------------------------------------------------------------------------- */

/**
 * §8.5 daily quests. A quest's `metric` is what the game counts it against, and there are only three
 * counters, so `metric` — not `key` — is the closed set. That lets an operator rename a quest, retune
 * its target and reward, or run two quests off the same counter, all without a deploy.
 */
export type QuestMetric = 'runs' | 'echoes' | 'best_cycle';

export const QUEST_METRICS: readonly QuestMetric[] = ['runs', 'echoes', 'best_cycle'];

export function isQuestMetric(value: unknown): value is QuestMetric {
  return QUEST_METRICS.includes(value as QuestMetric);
}

export interface QuestDefinition {
  key: string;
  label: string;
  metric: QuestMetric;
  /** What the running counter must reach. */
  target: number;
  /** SP paid once, the day the target is met. Deliberately outside the normal-mode sub-cap. */
  reward: number;
  enabled: boolean;
  sortOrder: number;
}

/**
 * Free wallets get one of these a day, rotating by UTC date; a pass holder gets all of them at once.
 * That rotation is positional, so `sortOrder` decides which day a free player sees which quest.
 */
export const DEFAULT_QUESTS: readonly QuestDefinition[] = [
  { key: 'first_signal', label: 'First Signal', metric: 'runs', target: 1, reward: 5, enabled: true, sortOrder: 10 },
  { key: 'echo_hunter', label: 'Echo Hunter', metric: 'echoes', target: 10, reward: 5, enabled: true, sortOrder: 20 },
  { key: 'deep_loop', label: 'Deep Loop', metric: 'best_cycle', target: 6, reward: 10, enabled: true, sortOrder: 30 },
];
