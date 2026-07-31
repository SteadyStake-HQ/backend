import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { SchedulerModule } from './scheduler/scheduler.module';
import { ConfigModule } from './config/config.module';
import { HistoryModule } from './history/history.module';
import { SupabaseModule } from './supabase/supabase.module';
import { PlansModule } from './plans/plans.module';
import { NetworksModule } from './networks/networks.module';
import { TokensModule } from './tokens/tokens.module';
import { TreasuryModule } from './treasury/treasury.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      serveRoot: '/',
      exclude: ['/api/(.*)'],
    }),
    SupabaseModule,
    ConfigModule,
    NetworksModule,
    HistoryModule,
    SchedulerModule,
    PlansModule,
    TokensModule,
    TreasuryModule,
  ],
})
export class AppModule {}
