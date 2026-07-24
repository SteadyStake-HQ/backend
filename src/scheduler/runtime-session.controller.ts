import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('api')
export class RuntimeSessionController {
  constructor(private readonly supabase: SupabaseService) {}

  @Get('runtime-session')
  async getRuntimeSession() {
    try {
      const session = await this.supabase.getLatestRuntimeSession();
      return {
        ok: true,
        configured: this.supabase.isConfigured(),
        session,
      };
    } catch (error) {
      throw new ServiceUnavailableException({
        ok: false,
        configured: this.supabase.isConfigured(),
        error: (error as Error).message,
      });
    }
  }
}
