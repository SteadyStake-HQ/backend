import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

const PORT = parseInt(process.env.PORT ?? '3340', 10);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(PORT);
  console.log(`DCA scheduler server running at http://localhost:${PORT}`);
  console.log('Dashboard: open the URL above to set run period and trigger runs.');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
