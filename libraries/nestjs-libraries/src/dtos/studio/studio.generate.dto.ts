import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';

export class StudioGenerateDto {
  /** Catalog model id, e.g. "kie:google/nano-banana". */
  @IsString()
  model: string;

  /**
   * Model-specific parameters. Not validated by class-validator - the shape
   * differs per model, so the catalog validates it against that model's
   * declared fields instead.
   */
  @IsObject()
  params: Record<string, any>;

  @IsOptional()
  @IsIn(['vertical', 'horizontal'])
  output?: 'vertical' | 'horizontal';
}
