import { Controller, Get } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';

@Controller('api')
export class StatusController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Get('status')
  getStatus() {
    return this.scheduler.getStatus();
  }
}
