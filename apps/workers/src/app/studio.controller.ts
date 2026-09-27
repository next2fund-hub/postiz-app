import { Controller } from '@nestjs/common';
import { EventPattern, Transport } from '@nestjs/microservices';
import { StudioService } from '@gitroom/nestjs-libraries/database/prisma/studio/studio.service';

/**
 * Runs Studio generations outside the web request.
 *
 * This is the whole point of the queue: a video model can run for minutes, and
 * the browser must be free to navigate away. Failures are swallowed here for
 * the same reason the post worker swallows them - one bad job must not take the
 * worker process down. StudioService records the failure on the job row, so it
 * is visible in the UI rather than lost to the logs.
 */
@Controller()
export class StudioWorkerController {
  constructor(private _studioService: StudioService) {}

  @EventPattern('studio-generate', Transport.REDIS)
  async generate(data: { id: string }) {
    try {
      await this._studioService.processJob(data.id);
    } catch (err) {
      console.log('Unhandled error in the studio worker', err);
    }
  }
}
