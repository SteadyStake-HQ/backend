import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { NetworkAllocationService } from './network-allocation.service';
import { isNetworkType, type NetworkType } from './network-registry';

/** Longer than this is a paste, not a note; it renders inside a table cell in the dashboard. */
const MAX_NOTE_LENGTH = 300;
const MAX_UPDATED_BY_LENGTH = 120;

interface NetworkBody {
  chainId?: number;
  note?: string | null;
  updatedBy?: string;
}

interface NetworkTypeBody extends NetworkBody {
  /** "mainnet" | "testnet", or null to fall back to the registry's own classification. */
  type?: string | null;
}

/**
 * Operator control over which networks the app offers and the relayer serves.
 *
 * Every action here is off-chain bookkeeping: nothing is deployed, upgraded, or withdrawn. Removing
 * a network hides it and stops automation on it; the vault, the plans, and every user's deposit and
 * gas tank balance on that chain are untouched and come back exactly as they were when it is
 * re-enabled.
 *
 * Guarded by ADMIN_API_TOKEN — see AdminTokenGuard.
 */
@Controller('api/admin/networks')
@UseGuards(AdminTokenGuard)
export class NetworkAdminController {
  constructor(private readonly networks: NetworkAllocationService) {}

  /** GET /api/admin/networks — every registered network, removed ones included. */
  @Get()
  async list() {
    try {
      const networks = await this.networks.listNetworks();
      return { ok: true, count: networks.length, networks };
    } catch (e) {
      throw new InternalServerErrorException({ ok: false, error: (e as Error).message });
    }
  }

  /**
   * POST /api/admin/networks/add — offer this network to users and let the relayer execute on it.
   * Body: { chainId, note?, updatedBy? }
   *
   * "Add" allocates a network the registry already describes; it cannot invent one. A chain that is
   * not in the registry has no RPC, no vault, and no verified stablecoin, so it is rejected.
   *
   * Clears any note left from when it was taken out of service, unless the caller supplies one.
   */
  @Post('add')
  @HttpCode(HttpStatus.OK)
  async add(@Body() body: NetworkBody) {
    return this.mutate({ note: null, ...body }, (chainId, note, updatedBy) =>
      this.networks.setStatus(chainId, 'enabled', { note, updatedBy }),
    );
  }

  /**
   * POST /api/admin/networks/pause — stop automation, keep the network visible.
   * Body: { chainId, note?, updatedBy? }
   *
   * No new plans are accepted and the relayer skips the chain, but users still see their plans there
   * and can cancel, withdraw, and reclaim gas tank funds. This is the safe way to take a chain out
   * of service while it holds user money.
   */
  @Post('pause')
  @HttpCode(HttpStatus.OK)
  async pause(@Body() body: NetworkBody) {
    return this.mutate(body, (chainId, note, updatedBy) =>
      this.networks.setStatus(chainId, 'paused', { note, updatedBy }),
    );
  }

  /**
   * POST /api/admin/networks/resume — lift a pause. Body: { chainId, updatedBy? }
   *
   * Clears the note unless the caller supplies a new one: it explained why the network was out of
   * service, and leaving it attached to a live network would have every reader of the API — and the
   * frontend — reporting a reason that no longer holds.
   */
  @Post('resume')
  @HttpCode(HttpStatus.OK)
  async resume(@Body() body: NetworkBody) {
    return this.mutate({ note: null, ...body }, (chainId, note, updatedBy) =>
      this.networks.setStatus(chainId, 'enabled', { note, updatedBy }),
    );
  }

  /**
   * POST /api/admin/networks/remove — hide the network from users and skip it in the relayer.
   * Body: { chainId, note?, updatedBy? }
   *
   * Prefer `pause` while a chain still has live plans: removal hides them from the UI, so a user
   * cannot reach their own plan to cancel it until the network is restored.
   */
  @Post('remove')
  @HttpCode(HttpStatus.OK)
  async remove(@Body() body: NetworkBody) {
    return this.mutate(body, (chainId, note, updatedBy) =>
      this.networks.setStatus(chainId, 'disabled', { note, updatedBy }),
    );
  }

  /**
   * POST /api/admin/networks/type — list this network under mainnet or testnet.
   * Body: { chainId, type: "mainnet" | "testnet" | null, updatedBy? }
   *
   * This is presentation only: it decides which NETWORK_TYPE list the network appears in, not what
   * the chain is. `null` reverts to the registry's own classification.
   */
  @Post('type')
  @HttpCode(HttpStatus.OK)
  async setType(@Body() body: NetworkTypeBody) {
    const chainId = parseChainId(body?.chainId);
    const updatedBy = optionalText(body?.updatedBy, MAX_UPDATED_BY_LENGTH, 'updatedBy');
    const type = parseNetworkType(body?.type);
    try {
      const network = await this.networks.setType(chainId, type, { updatedBy });
      return { ok: true, network };
    } catch (e) {
      throw toHttpError(e);
    }
  }

  /**
   * POST /api/admin/networks/reset — drop every override and return the network to its default
   * (enabled, with the registry's own mainnet/testnet classification). Body: { chainId }
   */
  @Post('reset')
  @HttpCode(HttpStatus.OK)
  async reset(@Body() body: NetworkBody) {
    const chainId = parseChainId(body?.chainId);
    try {
      const network = await this.networks.reset(chainId);
      return { ok: true, network };
    } catch (e) {
      throw toHttpError(e);
    }
  }

  private async mutate(
    body: NetworkBody,
    action: (
      chainId: number,
      note: string | null | undefined,
      updatedBy: string | null,
    ) => Promise<unknown>,
  ) {
    const chainId = parseChainId(body?.chainId);
    const note = body?.note === undefined ? undefined : optionalText(body.note, MAX_NOTE_LENGTH, 'note');
    const updatedBy = optionalText(body?.updatedBy, MAX_UPDATED_BY_LENGTH, 'updatedBy');
    try {
      const network = await action(chainId, note, updatedBy);
      return { ok: true, network };
    } catch (e) {
      throw toHttpError(e);
    }
  }
}

function parseChainId(value: unknown): number {
  const chainId = Number(value);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new BadRequestException({ ok: false, error: 'Invalid chainId' });
  }
  return chainId;
}

function parseNetworkType(value: unknown): NetworkType | null {
  if (value === null) return null;
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isNetworkType(trimmed)) {
    throw new BadRequestException({
      ok: false,
      error: 'type must be "mainnet", "testnet", or null to use the registry default',
    });
  }
  return trimmed;
}

function optionalText(value: unknown, maxLength: number, field: string): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new BadRequestException({ ok: false, error: `${field} must be a string` });
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) {
    throw new BadRequestException({
      ok: false,
      error: `${field} must be ${maxLength} characters or fewer`,
    });
  }
  return trimmed;
}

/** BadRequest from the service (unregistered chain) must stay a 400, not become a 500. */
function toHttpError(e: unknown): Error {
  if (e instanceof BadRequestException) return e;
  return new InternalServerErrorException({ ok: false, error: (e as Error).message });
}
