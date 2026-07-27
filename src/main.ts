import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const PORT = parseInt(process.env.PORT ?? '3340', 10);
/**
 * IPv6 wildcard, which Node binds dual-stack — it accepts IPv4 too. Not '0.0.0.0': that is
 * IPv4-only, and a platform proxy that reaches the container over an IPv6 internal network
 * (Railway's does) then finds nothing listening, which surfaces as a 502, not a crash.
 */
const HOST = process.env.HOST ?? '::';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(PORT, HOST);
  console.log(`DCA scheduler server listening on [${HOST}]:${PORT}`);
  console.log('Dashboard: open the URL above to set run period and trigger runs.');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
