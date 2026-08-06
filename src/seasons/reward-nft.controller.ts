import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { isAddress } from 'viem';
import { AdminTokenGuard } from '../admin/admin-token.guard';
import { isRegisteredChainId } from '../networks/network-registry';
import {
  ensureRewardNftContractsSchema,
  listRewardNftContracts,
  setRewardNftContractEnabled,
  upsertRewardNftContract,
} from '../supabase/reward-nft-contracts';

/**
 * Admin registry of deployed reward-NFT contracts. The reward page's distribute modal lists the
 * enabled entries; an admin can also paste an address directly there. Guarded by the same
 * ADMIN_API_TOKEN as the other privileged endpoints.
 */
@Controller('api/admin/reward-nfts')
@UseGuards(AdminTokenGuard)
export class RewardNftController {
  /** GET /api/admin/reward-nfts?enabledOnly= — list registered reward-NFT contracts. */
  @Get()
  async list(@Query('enabledOnly') enabledOnly?: string) {
    await ensureRewardNftContractsSchema();
    return { ok: true, contracts: await listRewardNftContracts(enabledOnly === 'true') };
  }

  /** POST /api/admin/reward-nfts — register (or update) a contract by (chainId, address). */
  @Post()
  async create(@Body() body: { chainId?: number; address?: string; name?: string; kind?: string; enabled?: boolean }) {
    await ensureRewardNftContractsSchema();
    const chainId = Number(body.chainId);
    if (!Number.isInteger(chainId) || !isRegisteredChainId(chainId)) {
      throw new BadRequestException({ ok: false, error: `Unknown or missing chainId.` });
    }
    if (!body.address || !isAddress(body.address)) {
      throw new BadRequestException({ ok: false, error: 'A valid contract address is required.' });
    }
    if (!body.name?.trim()) {
      throw new BadRequestException({ ok: false, error: 'name is required.' });
    }
    const contract = await upsertRewardNftContract({
      chainId,
      address: body.address,
      name: body.name.trim(),
      kind: body.kind?.trim() || 'season_reward_nft',
      enabled: body.enabled ?? true,
    });
    return { ok: true, contract };
  }

  /** PATCH /api/admin/reward-nfts/:id — enable/disable a contract. */
  @Patch(':id')
  async setEnabled(@Param('id', ParseIntPipe) id: number, @Body() body: { enabled?: boolean }) {
    await ensureRewardNftContractsSchema();
    const contract = await setRewardNftContractEnabled(id, body.enabled !== false);
    if (!contract) throw new BadRequestException({ ok: false, error: 'Unknown reward-NFT contract.' });
    return { ok: true, contract };
  }
}
