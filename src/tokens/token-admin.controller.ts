import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { TokenListService } from './token-list.service';

const MAX_UPDATED_BY_LENGTH = 120;

interface TokenBody {
  chainId?: number;
  address?: string;
  updatedBy?: string;
}

interface AddTokenBody extends TokenBody {
  symbol?: string;
  name?: string;
  decimals?: number;
  logoUrl?: string | null;
}

interface RemoveTokenBody extends TokenBody {
  /** Drop the row entirely instead of hiding it. A later import may then bring the token back. */
  purge?: boolean;
}

interface ImportBody {
  chainId?: number;
  sources?: string[];
  limit?: number;
  replace?: boolean;
  updatedBy?: string;
}

/**
 * Operator control over which tokens each network offers.
 *
 * Everything here is off-chain bookkeeping. Removing a token hides it from the "new plan" list; the
 * plans that already buy it keep running, and their holdings, deposits and gas tanks are untouched.
 * Nothing on this controller can move a balance.
 *
 * Guarded by ADMIN_API_TOKEN — see AdminTokenGuard.
 */
@Controller('api/admin/tokens')
@UseGuards(AdminTokenGuard)
export class TokenAdminController {
  constructor(private readonly tokens: TokenListService) {}

  /** GET /api/admin/tokens/summary — every network with its token counts and available providers. */
  @Get('summary')
  async summary() {
    try {
      const chains = await this.tokens.summary();
      return { ok: true, chains };
    } catch (e) {
      throw toHttpError(e);
    }
  }

  /** GET /api/admin/tokens?chainId=56 — one chain's tokens, removed ones included. */
  @Get()
  async list(@Query('chainId') chainId?: string) {
    const id = parseChainId(chainId);
    try {
      const tokens = await this.tokens.listForAdmin(id);
      return {
        ok: true,
        chainId: id,
        count: tokens.length,
        enabled: tokens.filter((t) => t.enabled).length,
        tokens,
      };
    } catch (e) {
      throw toHttpError(e);
    }
  }

  /**
   * POST /api/admin/tokens/add — add one token by address.
   * Body: { chainId, address, symbol?, name?, decimals?, logoUrl?, updatedBy? }
   *
   * Identity is read off the chain; the optional fields are overrides for a token whose contract
   * answers badly. See TokenListService.addToken for why `decimals` is treated as the dangerous one.
   */
  @Post('add')
  @HttpCode(HttpStatus.OK)
  async add(@Body() body: AddTokenBody) {
    try {
      const token = await this.tokens.addToken({
        chainId: parseChainId(body?.chainId),
        address: String(body?.address ?? ''),
        symbol: optionalText(body?.symbol, 32, 'symbol') ?? undefined,
        name: optionalText(body?.name, 120, 'name') ?? undefined,
        decimals: parseOptionalDecimals(body?.decimals),
        logoUrl: optionalText(body?.logoUrl, 500, 'logoUrl'),
        addedBy: optionalText(body?.updatedBy, MAX_UPDATED_BY_LENGTH, 'updatedBy'),
      });
      return { ok: true, token };
    } catch (e) {
      throw toHttpError(e);
    }
  }

  /**
   * POST /api/admin/tokens/remove — take a token out of the list users pick from.
   * Body: { chainId, address, purge?, updatedBy? }
   */
  @Post('remove')
  @HttpCode(HttpStatus.OK)
  async remove(@Body() body: RemoveTokenBody) {
    const chainId = parseChainId(body?.chainId);
    const address = String(body?.address ?? '');
    try {
      const result = await this.tokens.removeToken(chainId, address, {
        purge: body?.purge === true,
        updatedBy: optionalText(body?.updatedBy, MAX_UPDATED_BY_LENGTH, 'updatedBy'),
      });
      if (!result.removed) {
        throw new NotFoundException({
          ok: false,
          error: `Chain ${chainId} has no token ${address} in its list.`,
        });
      }
      return { ok: true, purged: result.purged, token: result.token };
    } catch (e) {
      throw toHttpError(e);
    }
  }

  /** POST /api/admin/tokens/restore — put a removed token back. Body: { chainId, address } */
  @Post('restore')
  @HttpCode(HttpStatus.OK)
  async restore(@Body() body: TokenBody) {
    const chainId = parseChainId(body?.chainId);
    const address = String(body?.address ?? '');
    try {
      const token = await this.tokens.restoreToken(
        chainId,
        address,
        optionalText(body?.updatedBy, MAX_UPDATED_BY_LENGTH, 'updatedBy'),
      );
      if (!token) {
        throw new NotFoundException({
          ok: false,
          error: `Chain ${chainId} has no token ${address} in its list.`,
        });
      }
      return { ok: true, token };
    } catch (e) {
      throw toHttpError(e);
    }
  }

  /**
   * POST /api/admin/tokens/import — build the list from the external providers.
   * Body: { chainId, sources?, limit?, replace?, updatedBy? }
   *
   * Merges by default: existing rows are refreshed, new ones added, and tokens an operator removed
   * stay removed. `replace: true` empties the chain first, which discards those removals too.
   *
   * Answers 200 with a per-provider report even when a provider failed — a partial list plus the
   * reason is more use to the operator standing at the dashboard than a 502.
   */
  @Post('import')
  @HttpCode(HttpStatus.OK)
  async import(@Body() body: ImportBody) {
    try {
      const report = await this.tokens.importChain({
        chainId: parseChainId(body?.chainId),
        sources: body?.sources,
        limit: body?.limit,
        replace: body?.replace === true,
        updatedBy: optionalText(body?.updatedBy, MAX_UPDATED_BY_LENGTH, 'updatedBy'),
      });
      return { ok: true, report };
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

function parseOptionalDecimals(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const decimals = Number(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new BadRequestException({ ok: false, error: 'decimals must be an integer from 0 to 36' });
  }
  return decimals;
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

/** A 400 or 404 raised by the service has to stay what it is rather than become a 500. */
function toHttpError(e: unknown): Error {
  if (e instanceof BadRequestException || e instanceof NotFoundException) return e;
  return new InternalServerErrorException({ ok: false, error: (e as Error).message });
}
