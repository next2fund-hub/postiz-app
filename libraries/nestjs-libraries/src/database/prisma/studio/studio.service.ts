import { HttpException, Injectable } from '@nestjs/common';
import { StudioRepository } from '@gitroom/nestjs-libraries/database/prisma/studio/studio.repository';
import { StudioCatalogService } from '@gitroom/nestjs-libraries/studio/studio.catalog.service';
import { MediaRepository } from '@gitroom/nestjs-libraries/database/prisma/media/media.repository';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { BullMqClient } from '@gitroom/nestjs-libraries/bull-mq-transport-new/client';
import {
  StudioCapability,
  StudioOutput,
} from '@gitroom/nestjs-libraries/studio/studio.types';
import { timer } from '@gitroom/helpers/utils/timer';

/** How long the worker will chase one generation before giving up. */
const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 15 * 60_000;

@Injectable()
export class StudioService {
  private storage = UploadFactory.createStorage();

  constructor(
    private _studioRepository: StudioRepository,
    private _catalog: StudioCatalogService,
    private _mediaRepository: MediaRepository,
    private _workerServiceProducer: BullMqClient
  ) {}

  listModels(capability?: StudioCapability) {
    return this._catalog.list(capability);
  }

  listJobs(organizationId: string, capability?: string) {
    return this._studioRepository.list(organizationId, capability);
  }

  getJob(organizationId: string, id: string) {
    return this._studioRepository.getById(organizationId, id);
  }

  deleteJob(organizationId: string, id: string) {
    return this._studioRepository.delete(organizationId, id);
  }

  /**
   * Queue a generation and return immediately.
   *
   * The HTTP request deliberately does NOT wait for the model. Generation runs
   * for minutes, and holding the request open means a proxy timeout throws away
   * a result the provider already produced and charged for.
   */
  async createJob(
    organizationId: string,
    body: { model: string; params: Record<string, any>; output?: StudioOutput }
  ) {
    const model = this._catalog.get(body.model);
    if (!model) {
      throw new HttpException(`Unknown model ${body.model}`, 400);
    }

    const provider = this._catalog.getProvider(model.provider);
    if (!provider?.isConfigured()) {
      throw new HttpException(
        `${model.provider} is not configured on this server`,
        409
      );
    }

    const errors = this._catalog.validate(model, body.params || {});
    if (errors.length) {
      throw new HttpException({ message: errors }, 400);
    }

    const job = await this._studioRepository.create({
      organizationId,
      provider: model.provider,
      model: model.id,
      capability: model.capability,
      prompt: body.params?.prompt,
      params: body.params || {},
      output: body.output,
    });

    this._workerServiceProducer.emit('studio-generate', {
      id: job.id,
      payload: { id: job.id },
    });

    return job;
  }

  /**
   * Run one job to completion. Called from the workers process, never from a
   * web request.
   */
  async processJob(id: string) {
    const job = await this._studioRepository.getInternal(id);
    if (!job || job.deletedAt) {
      return;
    }

    const model = this._catalog.get(job.model);
    if (!model) {
      await this._studioRepository.markFailed(id, `Unknown model ${job.model}`);
      return;
    }

    const provider = this._catalog.getProvider(model.provider);
    if (!provider?.isConfigured()) {
      await this._studioRepository.markFailed(
        id,
        `${model.provider} is not configured`
      );
      return;
    }

    try {
      const { externalId } = await provider.submit(
        model,
        (job.params as Record<string, any>) || {},
        (job.output as StudioOutput) || undefined
      );
      await this._studioRepository.markRunning(id, externalId);

      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await timer(POLL_INTERVAL_MS);
        const result = await provider.poll(externalId);

        if (result.state === 'failed') {
          await this._studioRepository.markFailed(
            id,
            result.error || 'Generation failed'
          );
          return;
        }

        if (result.state === 'success') {
          const urls = result.resultUrls || [];
          // Provider URLs expire - kie.ai deletes results after 24h - so the
          // asset has to be copied into our own storage before it is useful
          // for anything scheduled further out than that.
          const stored = await this.storage.uploadSimple(urls[0]);
          const media = await this._mediaRepository.saveFile(
            job.organizationId,
            stored.split('/').pop(),
            stored
          );
          await this._studioRepository.markSuccess(id, urls, media.id);
          return;
        }
      }

      await this._studioRepository.markFailed(
        id,
        `Timed out after ${POLL_TIMEOUT_MS / 60_000} minutes`
      );
    } catch (err: any) {
      await this._studioRepository.markFailed(
        id,
        err?.message || 'Unexpected error'
      );
    }
  }
}
