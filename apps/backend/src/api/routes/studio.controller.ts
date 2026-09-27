import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import { StudioService } from '@gitroom/nestjs-libraries/database/prisma/studio/studio.service';
import { StudioGenerateDto } from '@gitroom/nestjs-libraries/dtos/studio/studio.generate.dto';
import { StudioCapability } from '@gitroom/nestjs-libraries/studio/studio.types';

@ApiTags('Studio')
@Controller('/studio')
export class StudioController {
  constructor(private _studioService: StudioService) {}

  /**
   * The model catalog. Includes models whose provider is not configured, with
   * `available: false`, so the UI can explain itself instead of rendering an
   * empty page.
   */
  @Get('/models')
  models(@Query('capability') capability?: StudioCapability) {
    return this._studioService.listModels(capability);
  }

  /** Remaining provider credits. */
  @Get('/credits')
  credits() {
    return this._studioService.balances();
  }

  @Get('/jobs')
  jobs(
    @GetOrgFromRequest() org: Organization,
    @Query('capability') capability?: string
  ) {
    return this._studioService.listJobs(org.id, capability);
  }

  @Get('/jobs/:id')
  job(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._studioService.getJob(org.id, id);
  }

  /** Queues the generation and returns the job immediately. */
  @Post('/generate')
  generate(
    @GetOrgFromRequest() org: Organization,
    @Body() body: StudioGenerateDto
  ) {
    return this._studioService.createJob(org.id, body);
  }

  @Delete('/jobs/:id')
  remove(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._studioService.deleteJob(org.id, id);
  }
}
