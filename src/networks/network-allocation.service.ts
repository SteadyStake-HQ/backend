import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  clearNetworkAllocation,
  getNetworkAllocations,
  getNonExecutableChainIds,
  setNetworkAllocation,
  type NetworkAllocation,
  type NetworkStatus,
} from '../supabase/network-allocations';
import { getAllNetworks, getStableSymbol, type NetworkContracts } from '../config';
import {
  getRegistryEntry,
  getRegistryRpc,
  isRegisteredChainId,
  NETWORK_REGISTRY,
  type NetworkRegistryEntry,
  type NetworkType,
} from './network-registry';

/** One network as the frontend and the operator dashboard see it: registry facts ⊕ operator intent. */
export interface AllocatedNetwork {
  chainId: number;
  key: string;
  name: string;
  /** Effective classification: the operator's override when set, else the registry's own. */
  type: NetworkType;
  /** True when `type` came from an operator override rather than the registry. */
  typeOverridden: boolean;
  status: NetworkStatus;
  /** Shown to users and switchable. False only for a removed network. */
  visible: boolean;
  /** New plans may be created here. False when paused or removed. */
  acceptsNewPlans: boolean;
  /** The relayer will auto-execute here. False when paused or removed. */
  executable: boolean;
  /** True once the chain has a DCAVault and a funded-capable GasTank in deployed-addresses.json. */
  deployed: boolean;
  explorerUrl: string;
  nativeSymbol: string;
  stableSymbol: string;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  contracts: NetworkContracts['contracts'] | null;
}

/**
 * Reads and writes which networks are allocated to users and to the relayer.
 *
 * Two sources are combined on every read:
 *   - the registry, which is code and cannot be edited at runtime (name, RPC, explorer, default type)
 *   - the allocation store, which an operator edits through the admin API (status, type override)
 *
 * Nothing here is cached. The read is one small query against a table with at most one row per
 * chain, and a stale cache on this particular state would mean executing on a network an operator
 * has just paused — the one outcome the feature exists to prevent.
 */
@Injectable()
export class NetworkAllocationService {
  private readonly logger = new Logger(NetworkAllocationService.name);

  /** Every registered network with its effective allocation, in registry (display) order. */
  async listNetworks(filter?: { type?: NetworkType }): Promise<AllocatedNetwork[]> {
    const allocations = await getNetworkAllocations();
    const deployedByChain = new Map(getAllNetworks().map((n) => [n.chainId, n]));
    return NETWORK_REGISTRY.map((entry) =>
      this.resolve(entry, allocations.get(entry.chainId) ?? null, deployedByChain.get(entry.chainId)),
    ).filter((network) => !filter?.type || network.type === filter.type);
  }

  /**
   * Chain IDs the relayer must not execute on, i.e. the paused and removed ones.
   *
   * Expressed as the excluded set rather than the allowed set on purpose: the executor resolves its
   * chain list from the deployment, and allocation must only ever *subtract* from that answer. An
   * allow-list here would silently re-enable a chain nobody has deployed to.
   */
  async getNonExecutableChainIds(): Promise<Set<number>> {
    return getNonExecutableChainIds();
  }

  async setStatus(
    chainId: number,
    status: NetworkStatus,
    options?: { note?: string | null; updatedBy?: string | null },
  ): Promise<AllocatedNetwork> {
    this.requireRegistered(chainId);
    const allocation = await setNetworkAllocation({
      chainId,
      status,
      note: options?.note,
      updatedBy: options?.updatedBy,
    });
    this.logger.log(
      `Network ${chainId} set to ${status}${options?.updatedBy ? ` by ${options.updatedBy}` : ''}.`,
    );
    return this.resolveOne(allocation);
  }

  /** "Set for mainnet" / "set for testnet". Pass null to fall back to the registry's own type. */
  async setType(
    chainId: number,
    type: NetworkType | null,
    options?: { updatedBy?: string | null },
  ): Promise<AllocatedNetwork> {
    const entry = this.requireRegistered(chainId);
    if (type && type !== entry.type) {
      // Not refused — an operator may legitimately want a testnet listed alongside mainnets while
      // staging — but it is worth a line in the log, because getting it wrong shows real chains and
      // test chains in the same list to users.
      this.logger.warn(
        `Network ${chainId} (${entry.name}) is a ${entry.type} in the registry but is being listed as ${type}.`,
      );
    }
    const allocation = await setNetworkAllocation({
      chainId,
      typeOverride: type,
      updatedBy: options?.updatedBy,
    });
    return this.resolveOne(allocation);
  }

  /** Revert a network to its registry default: enabled, registry type, no note. */
  async reset(chainId: number): Promise<AllocatedNetwork> {
    const entry = this.requireRegistered(chainId);
    await clearNetworkAllocation(chainId);
    const deployed = getAllNetworks().find((n) => n.chainId === chainId);
    return this.resolve(entry, null, deployed);
  }

  private requireRegistered(chainId: number): NetworkRegistryEntry {
    const entry = getRegistryEntry(chainId);
    if (!entry || !isRegisteredChainId(chainId)) {
      throw new BadRequestException({
        ok: false,
        error:
          `Chain ${chainId} is not in the network registry. A network has to be added to ` +
          `backend/src/networks/network-registry.ts (and deployed) before it can be allocated.`,
      });
    }
    return entry;
  }

  private async resolveOne(allocation: NetworkAllocation): Promise<AllocatedNetwork> {
    const entry = this.requireRegistered(allocation.chainId);
    const deployed = getAllNetworks().find((n) => n.chainId === allocation.chainId);
    return this.resolve(entry, allocation, deployed);
  }

  private resolve(
    entry: NetworkRegistryEntry,
    allocation: NetworkAllocation | null,
    deployed: NetworkContracts | undefined,
  ): AllocatedNetwork {
    const status = allocation?.status ?? 'enabled';
    const type = allocation?.typeOverride ?? entry.type;
    return {
      chainId: entry.chainId,
      key: entry.key,
      name: entry.name,
      type,
      typeOverridden: allocation?.typeOverride != null,
      status,
      visible: status !== 'disabled',
      // Operator intent only, deliberately: `deployed` is reported separately rather than folded in
      // here. Whether a chain without a GasTank can take a plan is a question the app already
      // answers its own way, and quietly overriding that from the allocation API would change a
      // working flow on every chain whose GasTank is still the zero address.
      acceptsNewPlans: status === 'enabled',
      executable: status === 'enabled',
      deployed: Boolean(deployed?.hasGasTank),
      explorerUrl: entry.explorerUrl,
      nativeSymbol: entry.nativeSymbol,
      stableSymbol: getStableSymbol(entry.chainId),
      note: allocation?.note ?? null,
      updatedBy: allocation?.updatedBy ?? null,
      updatedAt: allocation?.updatedAt ? allocation.updatedAt.toISOString() : null,
      contracts: deployed?.contracts ?? null,
    };
  }

  /** RPC the backend would use for this chain; exposed for the deployments page. */
  getRpc(chainId: number): string | null {
    return getRegistryRpc(chainId);
  }
}
