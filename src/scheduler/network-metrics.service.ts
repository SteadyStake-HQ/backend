import { Injectable } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createPublicClient, http } from 'viem';
import { CHAIN_NAMES, getRpc, getVaultUsdcGasTank } from '../config';
import { SupabaseService } from '../supabase/supabase.service';
import { getDcaPlanMembers } from '../supabase/dca-plans-store';

const DCA_VAULT_METRICS_ABI = [
  { type: 'function', name: 'totalFeesCollected', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalAssets', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'getActiveSchedules', inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'uint256[]' }], stateMutability: 'view' },
  { type: 'function', name: 'getEnrolledScheduleIds', inputs: [{ name: 'user', type: 'address' }], outputs: [{ type: 'uint256[]' }], stateMutability: 'view' },
] as const;

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;

type DeployedAddresses = Record<string, { chainId?: number; GasTank?: string }>;

@Injectable()
export class NetworkMetricsService {
  private metricsCache:
    | {
        payload: {
          trackedMembers: number;
          networks: Array<Record<string, unknown>>;
          updatedAt: string;
        };
        cachedAt: number;
      }
    | null = null;
  private inFlightMetricsPromise:
    | Promise<{
        trackedMembers: number;
        networks: Array<Record<string, unknown>>;
        updatedAt: string;
      }>
    | null = null;

  constructor(private readonly supabase: SupabaseService) {}

  private getDeployedMetricChainIds(): number[] {
    try {
      const candidates = [
        join(__dirname, '..', '..', 'deployed-addresses.json'),
        join(process.cwd(), 'deployed-addresses.json'),
        join(process.cwd(), 'backend', 'deployed-addresses.json'),
      ];
      const deployedPath = candidates.find((candidate) => existsSync(candidate));
      if (!deployedPath) return [];
      const raw = readFileSync(deployedPath, 'utf-8');
      const deployed = JSON.parse(raw) as DeployedAddresses;
      return Object.entries(deployed)
        .filter(([, entry]) => {
          const gasTank = entry?.GasTank ?? '';
          return gasTank && gasTank !== '0x0000000000000000000000000000000000000000';
        })
        .map(([chainId]) => Number(chainId))
        .filter((chainId) => !Number.isNaN(chainId))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  /**
   * Members to report metrics for, from the database: everyone with a recorded DCA plan, unioned
   * with the automation registry.
   *
   * This replaces a ScheduleCreated log scan (1.5M blocks in 200k chunks). That scan could not
   * work as written — public RPCs cap eth_getLogs ranges far below 200k (sepolia.base.org allows
   * ~1000), so it threw and was swallowed, contributing nothing but latency. Plans are recorded to
   * dca_plans as they are created, so the DB already holds every user it was trying to find.
   */
  private async getRegisteredMembers(): Promise<string[]> {
    if (!this.supabase.isConfigured()) return [];
    try {
      return await getDcaPlanMembers();
    } catch {
      return [];
    }
  }

  async getNetworkMetrics(forceRefresh = false) {
    if (!forceRefresh && this.metricsCache && Date.now() - this.metricsCache.cachedAt < 60 * 1000) {
      return this.metricsCache.payload;
    }
    if (!forceRefresh && this.inFlightMetricsPromise) {
      return this.inFlightMetricsPromise;
    }
    this.inFlightMetricsPromise = this.computeNetworkMetrics()
      .then((payload) => {
        this.metricsCache = { payload, cachedAt: Date.now() };
        return payload;
      })
      .catch((error) => {
        if (this.metricsCache) {
          return this.metricsCache.payload;
        }
        throw error;
      })
      .finally(() => {
        this.inFlightMetricsPromise = null;
      });
    return this.inFlightMetricsPromise;
  }

  // No forceRefresh parameter: it only ever bypassed the discovered-users log-scan cache, and
  // members now come from the database on every call. getNetworkMetrics still honours it for the
  // metrics cache itself.
  private async computeNetworkMetrics() {
    const members = await this.getRegisteredMembers();
    const membersByChain = new Map<number, string[]>();

    for (const member of members) {
      const [chainIdStr, user] = member.split(':');
      const chainId = Number(chainIdStr);
      if (!user || Number.isNaN(chainId)) continue;
      const list = membersByChain.get(chainId) ?? [];
      list.push(user);
      membersByChain.set(chainId, list);
    }

    const chainIds = this.getDeployedMetricChainIds();
    const networks = await Promise.all(
      chainIds.map(async (chainId) => {
        const cfg = getVaultUsdcGasTank(chainId);
        const rpcUrl = getRpc(chainId);

        if (!cfg || !rpcUrl) {
          return {
            chainId,
            name: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
            vault: cfg?.vault ?? '',
            gasTank: cfg?.gasTank ?? '',
            claimableFeesUsdc6: '0',
            gasTankContractBalanceUsdc6: '0',
            totalActivePlanCount: 0,
            autoExecutingPlanCount: 0,
            totalLockedBalanceUsdc6: '0',
            trackedUserCount: 0,
            error: 'Missing RPC or deployed contract config',
          };
        }

        const client = createPublicClient({ transport: http(rpcUrl) });
        const discoveredUsers = membersByChain.get(chainId) ?? [];

        try {
          const [claimableFeesUsdc6, totalAssetsUsdc6, gasTankContractBalanceUsdc6] = await Promise.all([
            client.readContract({
              address: cfg.vault as `0x${string}`,
              abi: DCA_VAULT_METRICS_ABI,
              functionName: 'totalFeesCollected',
            }) as Promise<bigint>,
            client.readContract({
              address: cfg.vault as `0x${string}`,
              abi: DCA_VAULT_METRICS_ABI,
              functionName: 'totalAssets',
            }) as Promise<bigint>,
            client.readContract({
              address: cfg.usdc as `0x${string}`,
              abi: ERC20_ABI,
              functionName: 'balanceOf',
              args: [cfg.gasTank as `0x${string}`],
            }) as Promise<bigint>,
          ]);
          let totalActivePlanCount = 0;
          let autoExecutingPlanCount = 0;
          let trackedUserCount = 0;

          await Promise.all(
            discoveredUsers.map(async (user) => {
              const userAddress = user as `0x${string}`;
              try {
                const [activeIds, enrolledIds] = await Promise.all([
                  client.readContract({
                    address: cfg.vault as `0x${string}`,
                    abi: DCA_VAULT_METRICS_ABI,
                    functionName: 'getActiveSchedules',
                    args: [userAddress],
                  }) as Promise<bigint[]>,
                  client.readContract({
                    address: cfg.vault as `0x${string}`,
                    abi: DCA_VAULT_METRICS_ABI,
                    functionName: 'getEnrolledScheduleIds',
                    args: [userAddress],
                  }) as Promise<bigint[]>,
                ]);

                totalActivePlanCount += activeIds.length;
                autoExecutingPlanCount += enrolledIds.length;
                if (activeIds.length > 0 || enrolledIds.length > 0) {
                  trackedUserCount += 1;
                }
              } catch {
                // skip per-user read failures but keep network payload alive
              }
            }),
          );

          const totalLockedBalanceUsdc6 =
            totalAssetsUsdc6 > claimableFeesUsdc6
              ? totalAssetsUsdc6 - claimableFeesUsdc6
              : 0n;

          return {
            chainId,
            name: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
            vault: cfg.vault,
            gasTank: cfg.gasTank,
            claimableFeesUsdc6: claimableFeesUsdc6.toString(),
            gasTankContractBalanceUsdc6: gasTankContractBalanceUsdc6.toString(),
            totalActivePlanCount,
            autoExecutingPlanCount,
            totalLockedBalanceUsdc6: totalLockedBalanceUsdc6.toString(),
            trackedUserCount,
          };
        } catch (error) {
          return {
            chainId,
            name: CHAIN_NAMES[chainId] ?? `Chain ${chainId}`,
            vault: cfg.vault,
            gasTank: cfg.gasTank,
            claimableFeesUsdc6: '0',
            gasTankContractBalanceUsdc6: '0',
            totalActivePlanCount: 0,
            autoExecutingPlanCount: 0,
            totalLockedBalanceUsdc6: '0',
            trackedUserCount: 0,
            error: error instanceof Error ? error.message : 'Failed to read network metrics',
          };
        }
      }),
    );

    return {
      trackedMembers: networks.reduce((sum, network) => sum + Number(network.trackedUserCount || 0), 0),
      networks,
      updatedAt: new Date().toISOString(),
    };
  }
}
