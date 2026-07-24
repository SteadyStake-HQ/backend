import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { SchedulerModule } from './scheduler/scheduler.module';
import { ConfigModule } from './config/config.module';
import { HistoryModule } from './history/history.module';
import { SupabaseModule } from './supabase/supabase.module';
import { PlansModule } from './plans/plans.module';

@Module({
  imports: [
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      serveRoot: '/',
      exclude: ['/api/(.*)'],
    }),
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'frontend', 'public'),
      serveRoot: '/brand-assets',
      exclude: ['/api/(.*)'],
    }),
    SupabaseModule,
    ConfigModule,
    HistoryModule,
    SchedulerModule,
    PlansModule,
  ],
})
export class AppModule {}
