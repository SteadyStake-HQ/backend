import { Controller, Get, Sse, MessageEvent } from '@nestjs/common';
import { Observable } from 'rxjs';
import { SchedulerService, ExecutionStatusPayload } from './scheduler.service';

@Controller('api/execution')
export class ExecutionController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Get('status')
  getStatus() {
    return this.scheduler.getExecutionStatus();
  }

  @Sse('stream')
  stream(): Observable<MessageEvent> {
    const initial = this.scheduler.getExecutionStatus();
    const stream = this.scheduler.getExecutionStream();
    return new Observable<MessageEvent>((subscriber: { next: (v: MessageEvent) => void }) => {
      subscriber.next({
        data: JSON.stringify(initial),
      } as MessageEvent);
      const sub = stream.subscribe((data: ExecutionStatusPayload) => {
        subscriber.next({
          data: JSON.stringify(data),
        } as MessageEvent);
      });
      return () => sub.unsubscribe();
    });
  }
}
