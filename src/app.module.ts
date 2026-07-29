import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { SchedulerModule } from './scheduler/scheduler.module';
import { ConfigModule } from './config/config.module';
import { HistoryModule } from './history/history.module';
import { SupabaseModule } from './supabase/supabase.module';
import { PlansModule } from './plans/plans.module';
import { NetworksModule } from './networks/networks.module';

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
  ],
})
export class AppModule {}
