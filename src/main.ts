import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { allowedOrigins } from './campaign/campaign-config';
import { CAMPAIGN_AUTH_HEADER } from './campaign/campaign-auth';
import { ADMIN_TOKEN_HEADER } from './admin/admin-token.guard';

const PORT = parseInt(process.env.PORT ?? '3340', 10);
/**
 * IPv6 wildcard, which Node binds dual-stack — it accepts IPv4 too. Not '0.0.0.0': that is
 * IPv4-only, and a platform proxy that reaches the container over an IPv6 internal network
 * (Railway's does) then finds nothing listening, which surfaces as a 502, not a crash.
 */
const HOST = process.env.HOST ?? '::';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  /**
   * Cross-origin access, for the campaign only.
   *
   * Until the Early Supporter Campaign, every browser that talked to this backend was served by it —
   * the operator dashboard from `public/` — and the game reached it server-side from its own routes.
   * The presale site is different: it runs on presale.steadystake.org and calls the campaign API
   * directly from the page, so those origins have to be named.
   *
   * An explicit allowlist rather than `origin: true`, and it fails *closed*: with
   * CAMPAIGN_ALLOWED_ORIGINS unset, no cross-origin browser request is permitted at all. Reflecting
   * arbitrary origins alongside `credentials: true` would let any site read a signed-in user's
   * campaign profile, and while a campaign session cannot grant a boost, it can link a Telegram
   * account and record a referral — neither of which another site may do on a user's behalf.
   *
   * Same-origin callers (the dashboard) and server-side callers (the game) send no Origin header that
   * needs matching, so leaving this unconfigured breaks nothing that worked before.
   */
  const origins = allowedOrigins();
  if (origins.length > 0) {
    app.enableCors({
      origin: origins,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['content-type', CAMPAIGN_AUTH_HEADER, ADMIN_TOKEN_HEADER],
      credentials: true,
      maxAge: 86_400,
    });
    console.log(`CORS enabled for: ${origins.join(', ')}`);
  } else {
    console.log(
      'CORS disabled (CAMPAIGN_ALLOWED_ORIGINS unset). The presale campaign page will be blocked by the browser.',
    );
  }

  await app.listen(PORT, HOST);
  console.log(`DCA scheduler server listening on [${HOST}]:${PORT}`);
  console.log('Dashboard: open the URL above to set run period and trigger runs.');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
