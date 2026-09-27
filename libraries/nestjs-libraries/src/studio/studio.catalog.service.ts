import { Injectable } from '@nestjs/common';
import { KIE_MODELS } from '@gitroom/nestjs-libraries/studio/catalog/kie.catalog';
import { KieProvider } from '@gitroom/nestjs-libraries/studio/providers/kie.provider';
import { StudioProvider } from '@gitroom/nestjs-libraries/studio/providers/studio.provider';
import {
  StudioCapability,
  StudioModel,
  StudioModelListing,
  StudioProviderId,
} from '@gitroom/nestjs-libraries/studio/studio.types';

/**
 * The model registry: catalog entries joined to the providers that run them.
 *
 * Adding a model is a catalog edit. Adding a PROVIDER is a class plus one line
 * in `providers` below.
 */
@Injectable()
export class StudioCatalogService {
  private readonly providers: Record<StudioProviderId, StudioProvider>;

  constructor(kie: KieProvider) {
    this.providers = { kie };
  }

  private all(): StudioModel[] {
    return [...KIE_MODELS];
  }

  getProvider(id: StudioProviderId): StudioProvider {
    return this.providers[id];
  }

  /**
   * Catalog for the UI. Unconfigured providers are returned as
   * `available: false` rather than hidden, so the Studio can say "add a key"
   * instead of rendering an empty page with no explanation - which is exactly
   * how the missing KIEAI_API_KEY presented itself.
   */
  list(capability?: StudioCapability): StudioModelListing[] {
    return this.all()
      .filter((m) => !capability || m.capability === capability)
      .map((m) => ({
        ...m,
        available: !!this.providers[m.provider]?.isConfigured(),
      }));
  }

  get(id: string): StudioModel | undefined {
    return this.all().find((m) => m.id === id);
  }

  /**
   * Check submitted params against the model's declared fields.
   *
   * Returns messages rather than throwing so the caller decides the status
   * code. Unknown keys are dropped silently by `buildInput`, so this only has
   * to catch what is missing or unusable.
   */
  validate(model: StudioModel, params: Record<string, any>): string[] {
    const errors: string[] = [];

    for (const field of model.fields) {
      const value = params?.[field.name];
      const empty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);

      if (field.required && empty) {
        errors.push(`${field.label} is required`);
        continue;
      }
      if (empty) {
        continue;
      }

      if (
        (field.type === 'text' || field.type === 'textarea') &&
        field.maxLength &&
        String(value).length > field.maxLength
      ) {
        errors.push(`${field.label} must be ${field.maxLength} characters or fewer`);
      }

      if (
        field.type === 'select' &&
        !field.options.some((o) => o.value === String(value))
      ) {
        errors.push(`${field.label} is not one of the allowed values`);
      }

      if (field.type === 'number') {
        const n = Number(value);
        if (Number.isNaN(n)) {
          errors.push(`${field.label} must be a number`);
        } else if (field.min !== undefined && n < field.min) {
          errors.push(`${field.label} must be at least ${field.min}`);
        } else if (field.max !== undefined && n > field.max) {
          errors.push(`${field.label} must be at most ${field.max}`);
        }
      }
    }

    return errors;
  }
}
