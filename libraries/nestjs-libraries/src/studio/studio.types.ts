/**
 * Studio catalog types.
 *
 * A generation model is DATA, not a class. Postiz's original videos/ registry
 * used one decorated class per model, which does not scale to a provider that
 * sells dozens of them - adding a model meant writing a class, a DTO and a
 * React component. Here a model is a catalog entry describing its own input
 * fields, and one generic form renders it.
 */

export type StudioCapability = 'image' | 'video';

/** Normalised orientation. Each model maps this onto its own parameter. */
export type StudioOutput = 'vertical' | 'horizontal';

/**
 * What a model turns into what. Mirrors the distinctions kie.ai's own
 * catalogue draws - collapsing lip sync, upscales and avatars into
 * "text to video" would mislabel them and make the task filter useless.
 */
export type StudioMode =
  | 'text-to-image'
  | 'image-to-image'
  | 'text-to-video'
  | 'image-to-video'
  | 'reference-to-video'
  | 'video-to-video'
  | 'video-edit'
  | 'lip-sync'
  | 'upscale'
  | 'motion'
  | 'avatar';

export type StudioProviderId = 'kie';

interface FieldBase {
  name: string;
  label: string;
  description?: string;
  required?: boolean;
}

export type StudioParamField =
  | (FieldBase & { type: 'text'; maxLength?: number; placeholder?: string; default?: string })
  | (FieldBase & { type: 'textarea'; maxLength?: number; placeholder?: string; default?: string })
  | (FieldBase & {
      type: 'select';
      options: { value: string; label: string }[];
      default?: string;
      /** Select values are strings in the DOM; some APIs want a number. */
      coerce?: 'number';
    })
  | (FieldBase & { type: 'number'; min?: number; max?: number; default?: number })
  | (FieldBase & { type: 'boolean'; default?: boolean })
  | (FieldBase & { type: 'media'; max?: number; accept?: 'image' | 'video' });

export interface StudioModel {
  /** Stable internal id, namespaced by provider: "kie:google/nano-banana". */
  id: string;
  provider: StudioProviderId;
  /** The exact string the provider's API expects in its `model` field. */
  providerModel: string;
  title: string;
  description: string;
  /** Who makes the model - Google, ByteDance, Kling. Drives the provider filter. */
  vendor: string;
  capability: StudioCapability;
  mode: StudioMode;
  fields: StudioParamField[];
  /**
   * How to express orientation for this model. Omitted when the model's
   * aspect-ratio parameter has not been verified against the provider's docs -
   * guessing a field name produces a silently ignored parameter, which is
   * worse than not offering the control.
   */
  aspect?: { field: string; vertical: string; horizontal: string };
  docs?: string;
}

/** What the API hands the UI: a catalog entry plus whether it is usable. */
export interface StudioModelListing extends StudioModel {
  available: boolean;
}
