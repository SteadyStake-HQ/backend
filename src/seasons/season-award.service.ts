import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createPublicClient, createWalletClient, http, isAddress, zeroHash, type Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getRpc } from '../config';
import { getChain } from '../run-executor';
import { isRegisteredChainId } from '../networks/network-registry';
import { getFinalists, getSeason, setSeasonAwardTarget, setSeasonStatus, type SeasonRow } from '../supabase/seasons-store';
import {
  ensureNftAwardsSchema,
  getSeasonAwards,
  markAwardMinted,
  upsertRegisteredAward,
} from '../supabase/nft-awards-store';
import { getRewardNftContract } from '../supabase/reward-nft-contracts';
import { SeasonsService } from './seasons.service';
import { SEASON_NFT_ABI, buildTokenMetadataUri } from './season-nft';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Turns a finalized season into on-chain reward cards (blueprint §14): registerSeasonResult, then
 * one mintSeasonAward per eligible rank on the SeasonRewardNFT. Signs with the backend relayer key,
 * which holds FINALIZER_ROLE + MINTER_ROLE on the testnet contract.
 *
 * Testnet path: the key sends directly. On mainnet these calls must be routed through the treasury
 * multisig (§24) — the same ABI, proposed rather than sent. The contract is the ultimate guard:
 * register-once, mint-once, recipient only from the registered winners array.
 */
@Injectable()
export class SeasonAwardService {
  private readonly logger = new Logger(SeasonAwardService.name);

  constructor(private readonly seasons: SeasonsService) {}

  /**
   * Admin one-shot distribution from the reward page: pick the reward-NFT contract (a registry id or a
   * pasted chain+address), optionally override the winner wallets, persist the target on the season,
   * then register + mint. Idempotent — the underlying register/mint are register-once/mint-once.
   */
  async distribute(
    seasonId: number,
    input: {
      contractId?: number;
      chainId?: number;
      contract?: string;
      winners?: Array<{ rank?: number; wallet?: string; seasonRating?: number }>;
    },
  ) {
    await ensureNftAwardsSchema();
    const season = await this.mustGet(seasonId);
    if (season.status !== 'finalized' && season.status !== 'awarded') {
      throw new BadRequestException({ ok: false, error: 'A season must be Finalized before rewards can be distributed.' });
    }

    // Resolve the target contract: a registry id wins, otherwise an explicit chainId + address.
    let chainId: number;
    let contract: string;
    if (input.contractId != null) {
      const row = await getRewardNftContract(Number(input.contractId));
      if (!row) throw new BadRequestException({ ok: false, error: 'Unknown reward-NFT contract id.' });
      chainId = row.chainId;
      contract = row.address;
    } else {
      chainId = Number(input.chainId);
      contract = String(input.contract ?? '');
      if (!Number.isInteger(chainId) || !isRegisteredChainId(chainId)) {
        throw new BadRequestException({ ok: false, error: 'A valid, registered chainId is required.' });
      }
      if (!isAddress(contract)) {
        throw new BadRequestException({ ok: false, error: 'A valid NFT contract address is required.' });
      }
    }

    // Optional admin override of who wins each rank (also re-derives the snapshot hash).
    if (input.winners && input.winners.length > 0) {
      await this.seasons.setFinalists(seasonId, input.winners);
    }

    await setSeasonAwardTarget(seasonId, chainId, contract);
    await this.register(seasonId);
    return this.mintAll(seasonId);
  }

  private signer() {
    let pk = process.env.RELAYER_PRIVATE_KEY?.trim();
    if (!pk) throw new BadRequestException({ ok: false, error: 'RELAYER_PRIVATE_KEY is not configured.' });
    if (!pk.startsWith('0x')) pk = `0x${pk}`;
    return privateKeyToAccount(pk as `0x${string}`);
  }

  private clients(chainId: number) {
    const chain = getChain(chainId);
    const rpc = getRpc(chainId);
    if (!chain || !rpc) {
      throw new BadRequestException({ ok: false, error: `No chain/RPC for award chain ${chainId}.` });
    }
    const account = this.signer();
    return {
      account,
      chain,
      pub: createPublicClient({ chain, transport: http(rpc) }),
      wallet: createWalletClient({ account, chain, transport: http(rpc) }),
    };
  }

  private awardContext(season: SeasonRow) {
    if (season.status !== 'finalized' && season.status !== 'awarded') {
      throw new BadRequestException({ ok: false, error: 'A season must be Finalized before awarding NFTs.' });
    }
    if (!season.awardChainId || !season.nftContractAddress) {
      throw new BadRequestException({ ok: false, error: 'Season is missing award_chain_id or nft_contract_address.' });
    }
    if (!season.snapshotHash) {
      throw new BadRequestException({ ok: false, error: 'Season has no snapshot hash; finalize it first.' });
    }
    return { chainId: season.awardChainId, contract: season.nftContractAddress as `0x${string}` };
  }

  /** §14.2: register the frozen result on-chain, once. Records one nft_awards row per eligible rank. */
  async register(seasonId: number) {
    await ensureNftAwardsSchema();
    const season = await this.mustGet(seasonId);
    const { chainId, contract } = this.awardContext(season);
    const finalists = await getFinalists(seasonId);
    if (finalists.length === 0) {
      throw new BadRequestException({ ok: false, error: 'No finalists to register.' });
    }

    const winners: [`0x${string}`, `0x${string}`, `0x${string}`] = [ZERO_ADDRESS, ZERO_ADDRESS, ZERO_ADDRESS];
    const uris: [string, string, string] = ['', '', ''];
    for (const f of finalists) {
      const idx = f.finalRank - 1;
      if (idx < 0 || idx > 2) continue;
      winners[idx] = f.walletAddress as `0x${string}`;
      uris[idx] = buildTokenMetadataUri(seasonId, f.finalRank, process.env.SEASON_EXTERNAL_BASE);
    }

    const { pub, wallet, account, chain } = this.clients(chainId);

    // The contract registers once; skip the send if it already has this season.
    const already = await pub.readContract({ address: contract, abi: SEASON_NFT_ABI, functionName: 'seasonRegistered', args: [BigInt(seasonId)] });
    let registerTx: Hash | null = null;
    if (!already) {
      registerTx = await wallet.writeContract({
        address: contract,
        abi: SEASON_NFT_ABI,
        functionName: 'registerSeasonResult',
        args: [BigInt(seasonId), (season.rulesHash as `0x${string}`) ?? zeroHash, season.snapshotHash as `0x${string}`, winners, uris],
        account,
        chain,
      });
      const receipt = await pub.waitForTransactionReceipt({ hash: registerTx });
      if (receipt.status !== 'success') throw new BadRequestException({ ok: false, error: 'registerSeasonResult reverted.' });
      this.logger.log(`season ${seasonId}: registered on ${chainId} tx ${registerTx}`);
    }

    for (const f of finalists) {
      await upsertRegisteredAward({
        seasonId,
        rank: f.finalRank,
        walletAddress: f.walletAddress,
        chainId,
        contractAddress: contract,
        bonusSlots: 4 - f.finalRank,
        registerTransactionHash: registerTx,
      });
    }

    return { ok: true, seasonId, registerTransactionHash: registerTx, alreadyRegistered: already, ranks: finalists.map((f) => f.finalRank) };
  }

  /** §14.3: mint every registered-but-unminted rank, then move the season to Awarded. */
  async mintAll(seasonId: number) {
    await ensureNftAwardsSchema();
    const season = await this.mustGet(seasonId);
    const { chainId, contract } = this.awardContext(season);
    const awards = await getSeasonAwards(seasonId);
    if (awards.length === 0) {
      throw new BadRequestException({ ok: false, error: 'Nothing registered to mint; register the season first.' });
    }

    const { pub, wallet, account, chain } = this.clients(chainId);
    const minted: Array<{ rank: number; tokenId: string; txHash: string }> = [];

    for (const award of awards) {
      if (award.status === 'minted') continue;
      const tokenId: bigint = await pub.readContract({ address: contract, abi: SEASON_NFT_ABI, functionName: 'tokenIdFor', args: [BigInt(seasonId), award.rank] });

      // Skip if already minted on-chain (idempotent across retries).
      let exists = false;
      try {
        await pub.readContract({ address: contract, abi: SEASON_NFT_ABI, functionName: 'ownerOf', args: [tokenId] });
        exists = true;
      } catch {
        exists = false;
      }

      let txHash: string;
      if (exists) {
        txHash = award.mintTransactionHash ?? 'already-minted';
      } else {
        const hash = await wallet.writeContract({
          address: contract,
          abi: SEASON_NFT_ABI,
          functionName: 'mintSeasonAward',
          args: [BigInt(seasonId), award.rank],
          account,
          chain,
        });
        const receipt = await pub.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') throw new BadRequestException({ ok: false, error: `mintSeasonAward(rank ${award.rank}) reverted.` });
        txHash = hash;
        this.logger.log(`season ${seasonId} rank ${award.rank}: minted token ${tokenId} tx ${hash}`);
      }
      await markAwardMinted(seasonId, award.rank, tokenId.toString(), txHash);
      minted.push({ rank: award.rank, tokenId: tokenId.toString(), txHash });
    }

    // All registered ranks minted -> season is Awarded (§14.3 step 10).
    const refreshed = await getSeasonAwards(seasonId);
    if (refreshed.every((a) => a.status === 'minted')) {
      await setSeasonStatus(seasonId, ['finalized'], 'awarded');
    }

    return { ok: true, seasonId, minted, awards: await getSeasonAwards(seasonId) };
  }

  async status(seasonId: number) {
    await ensureNftAwardsSchema();
    await this.mustGet(seasonId);
    return { ok: true, seasonId, awards: await getSeasonAwards(seasonId) };
  }

  private async mustGet(seasonId: number): Promise<SeasonRow> {
    const season = await getSeason(seasonId);
    if (!season) throw new BadRequestException({ ok: false, error: 'Unknown season.' });
    return season;
  }
}
