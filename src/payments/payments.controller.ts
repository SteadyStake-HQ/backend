import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { PaymentsService } from './payments.service';

/**
 * Public Game Pass payment API (blueprint §21 Player APIs).
 *
 * Unguarded like the rest of the backend's read/config surface: creating an intent grants nothing —
 * only a confirmed on-chain `PassPaid` from the paying wallet activates a pass — so there is no
 * secret to protect here. The game passes the session-verified wallet address through from its own
 * HMAC session; this backend trusts that address only to *address* an intent, never to grant one.
 */
@Controller('api/payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  /** GET /api/payments/options — enabled networks + plan prices for the Game Pass screen. */
  @Get('options')
  options() {
    return this.payments.listCheckoutOptions();
  }

  /** POST /api/payments/intents { wallet, chainId, planId } — trusted checkout request. */
  @Post('intents')
  createIntent(@Body() body: { wallet?: string; chainId?: number; planId?: number }) {
    return this.payments.createIntent(body);
  }

  /** POST /api/payments/intents/:id/submit { txHash } — attach the submitted transaction. */
  @Post('intents/:id/submit')
  submit(@Param('id') id: string, @Body() body: { txHash?: string }) {
    return this.payments.submitTransaction(id, body?.txHash ?? '');
  }

  /** GET /api/payments/intents/:id — confirmation + resulting pass status (poll target). */
  @Get('intents/:id')
  status(@Param('id') id: string) {
    return this.payments.getIntentStatus(id);
  }

  /** GET /api/payments/entitlement/:wallet — current pass expiry/active for a wallet. */
  @Get('entitlement/:wallet')
  entitlement(@Param('wallet') wallet: string) {
    return this.payments.getEntitlement(wallet);
  }
}
