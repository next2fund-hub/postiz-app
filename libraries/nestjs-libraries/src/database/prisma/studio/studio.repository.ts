import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { StudioJobStatus } from '@prisma/client';

const LIST_SELECT = {
  id: true,
  provider: true,
  model: true,
  capability: true,
  status: true,
  prompt: true,
  output: true,
  resultUrls: true,
  mediaId: true,
  error: true,
  createdAt: true,
  finishedAt: true,
};

@Injectable()
export class StudioRepository {
  constructor(private _studioJob: PrismaRepository<'studioJob'>) {}

  create(data: {
    organizationId: string;
    provider: string;
    model: string;
    capability: string;
    prompt?: string;
    params: any;
    output?: string;
  }) {
    return this._studioJob.model.studioJob.create({
      data: {
        organization: { connect: { id: data.organizationId } },
        provider: data.provider,
        model: data.model,
        capability: data.capability,
        prompt: data.prompt,
        params: data.params,
        output: data.output,
      },
      select: LIST_SELECT,
    });
  }

  /** Scoped by org: a job id from another tenant must read as absent. */
  getById(organizationId: string, id: string) {
    return this._studioJob.model.studioJob.findFirst({
      where: { id, organizationId, deletedAt: null },
      select: LIST_SELECT,
    });
  }

  /** Unscoped, for the worker, which has a job id but no user context. */
  getInternal(id: string) {
    return this._studioJob.model.studioJob.findUnique({ where: { id } });
  }

  list(organizationId: string, capability?: string, take = 50) {
    return this._studioJob.model.studioJob.findMany({
      where: {
        organizationId,
        deletedAt: null,
        ...(capability ? { capability } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      select: LIST_SELECT,
    });
  }

  markRunning(id: string, externalId?: string) {
    return this._studioJob.model.studioJob.update({
      where: { id },
      data: {
        status: StudioJobStatus.RUNNING,
        startedAt: new Date(),
        ...(externalId ? { externalId } : {}),
        attempts: { increment: 1 },
      },
    });
  }

  markSuccess(id: string, resultUrls: string[], mediaId?: string) {
    return this._studioJob.model.studioJob.update({
      where: { id },
      data: {
        status: StudioJobStatus.SUCCESS,
        resultUrls,
        mediaId,
        finishedAt: new Date(),
      },
    });
  }

  markFailed(id: string, error: string) {
    return this._studioJob.model.studioJob.update({
      where: { id },
      data: {
        status: StudioJobStatus.FAILED,
        error: error.slice(0, 1000),
        finishedAt: new Date(),
      },
    });
  }

  delete(organizationId: string, id: string) {
    return this._studioJob.model.studioJob.updateMany({
      where: { id, organizationId },
      data: { deletedAt: new Date() },
    });
  }
}
