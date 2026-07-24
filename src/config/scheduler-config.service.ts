import { Injectable } from "@nestjs/common";
import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SupabaseService } from "../supabase/supabase.service";

const DEFAULT_INTERVAL_MS = 5 * 1000; // execution poll; plan cadence remains on-chain
const MAX_AUTOMATION_POLL_INTERVAL_MS = 5 * 1000;
const SCHEDULER_CONFIG_KV_KEY = "steadystake:scheduler:config";

export interface SchedulerConfig {
  intervalMs: number;
  /** Optional: chain IDs to run. Empty or absent = use env AUTOMATION_CHAIN_IDS or all chains with GasTank. */
  chainIds?: number[];
  staticTimeEnabled?: boolean;
  staticStartAt?: string;
}

export const PRESET_LABELS: { value: number; label: string }[] = [
  { value: 5 * 1000, label: "5 seconds (recommended)" },
];

@Injectable()
export class SchedulerConfigService {
  private inMemoryConfig: SchedulerConfig | null = null;
  private activeConfigPath: string | null = null;

  constructor(private readonly supabase: SupabaseService) {}

  private normalizeStaticStartAt(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const normalized = trimmed.includes("T")
      ? trimmed
      : trimmed.replace(" ", "T");
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return undefined;
    return date.toISOString();
  }

  private getConfigPath(): string {
    return join(process.cwd(), "scheduler-config.json");
  }

  private getFallbackConfigPath(): string {
    return join(tmpdir(), "steadystake-scheduler-config.json");
  }

  private getReadableConfigPaths(): string[] {
    const candidates = [this.getConfigPath(), this.getFallbackConfigPath()];
    const readable = candidates.filter((path) => existsSync(path));
    const activeFirst =
      this.activeConfigPath && readable.includes(this.activeConfigPath)
        ? [
            this.activeConfigPath,
            ...readable.filter((path) => path !== this.activeConfigPath),
          ]
        : readable.sort((a, b) => {
            try {
              return statSync(b).mtimeMs - statSync(a).mtimeMs;
            } catch {
              return 0;
            }
          });
    return activeFirst;
  }

  private sanitizeConfig(parsed: Partial<SchedulerConfig>): SchedulerConfig {
    const intervalMs =
      typeof parsed.intervalMs === "number" && parsed.intervalMs > 0
        ? Math.min(parsed.intervalMs, MAX_AUTOMATION_POLL_INTERVAL_MS)
        : DEFAULT_INTERVAL_MS;
    const chainIds = Array.isArray(parsed.chainIds)
      ? parsed.chainIds.filter((id) => typeof id === "number" && id > 0)
      : undefined;
    const staticStartAt = this.normalizeStaticStartAt(
      (parsed as Partial<SchedulerConfig> & { staticTime?: string })
        .staticStartAt ??
        (parsed as Partial<SchedulerConfig> & { staticTime?: string })
          .staticTime,
    );
    const staticTimeEnabled =
      parsed.staticTimeEnabled === true && typeof staticStartAt === "string";
    return {
      intervalMs,
      ...(chainIds?.length ? { chainIds } : {}),
      ...(staticStartAt ? { staticStartAt } : {}),
      ...(staticTimeEnabled ? { staticTimeEnabled } : {}),
    };
  }

  async hydrate(): Promise<SchedulerConfig> {
    if (this.supabase.isConfigured()) {
      try {
        const stored = await this.supabase.kvGetJson<Partial<SchedulerConfig>>(
          SCHEDULER_CONFIG_KV_KEY,
        );
        if (stored) {
          const next = this.sanitizeConfig(stored);
          this.inMemoryConfig = next;
          return next;
        }
      } catch {
        // fall through to file/in-memory sources
      }
    }
    return this.getConfig();
  }

  getConfig(): SchedulerConfig {
    if (this.inMemoryConfig) return this.inMemoryConfig;
    const paths = this.getReadableConfigPaths();
    for (const path of paths) {
      try {
        const raw = readFileSync(path, "utf-8");
        const next = this.sanitizeConfig(
          JSON.parse(raw) as Partial<SchedulerConfig>,
        );
        this.activeConfigPath = path;
        this.inMemoryConfig = next;
        return next;
      } catch {
        // try next source
      }
    }
    return this.inMemoryConfig ?? { intervalMs: DEFAULT_INTERVAL_MS };
  }

  async setConfig(config: Partial<SchedulerConfig>): Promise<SchedulerConfig> {
    const current = this.getConfig();
    const intervalMs =
      typeof config.intervalMs === "number" && config.intervalMs > 0
        ? Math.min(config.intervalMs, MAX_AUTOMATION_POLL_INTERVAL_MS)
        : current.intervalMs;
    const chainIds =
      config.chainIds === undefined
        ? current.chainIds
        : Array.isArray(config.chainIds)
          ? config.chainIds.filter((id) => typeof id === "number" && id > 0)
          : undefined;
    const requestedStaticTimeEnabled =
      config.staticTimeEnabled === undefined
        ? current.staticTimeEnabled === true
        : config.staticTimeEnabled === true;
    const staticStartAt =
      config.staticStartAt === undefined
        ? requestedStaticTimeEnabled
          ? current.staticStartAt
          : undefined
        : this.normalizeStaticStartAt(config.staticStartAt);
    const staticTimeEnabled =
      requestedStaticTimeEnabled && typeof staticStartAt === "string";
    const next: SchedulerConfig = {
      intervalMs,
      ...(chainIds?.length ? { chainIds } : {}),
      ...(staticStartAt ? { staticStartAt } : {}),
      ...(staticTimeEnabled ? { staticTimeEnabled } : {}),
    };
    const serialized = JSON.stringify(next, null, 2);
    if (this.supabase.isConfigured()) {
      try {
        await this.supabase.kvSetJson(SCHEDULER_CONFIG_KV_KEY, next);
        this.inMemoryConfig = next;
        return next;
      } catch (error) {
        console.warn(
          `Scheduler config Supabase persist failed: ${(error as Error).message}`,
        );
      }
    }
    const candidatePaths = [
      ...(this.activeConfigPath ? [this.activeConfigPath] : []),
      this.getConfigPath(),
      this.getFallbackConfigPath(),
    ].filter((path, index, list) => list.indexOf(path) === index);
    let lastError: Error | null = null;
    for (const path of candidatePaths) {
      try {
        writeFileSync(path, serialized, "utf-8");
        this.activeConfigPath = path;
        this.inMemoryConfig = next;
        return next;
      } catch (error) {
        lastError = error as Error;
      }
    }
    this.inMemoryConfig = next;
    if (lastError) {
      console.warn(
        `Scheduler config persisted in memory only: ${lastError.message}`,
      );
    }
    return next;
  }

  getPresetLabels(): { value: number; label: string }[] {
    return PRESET_LABELS;
  }
}
