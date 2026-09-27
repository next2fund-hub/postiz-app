import { StudioModel } from '@gitroom/nestjs-libraries/studio/studio.types';

/**
 * kie.ai model catalog.
 *
 * kie.ai exposes its whole market through ONE endpoint
 * (/api/v1/jobs/createTask), switched by the `model` string. It publishes no
 * machine-readable model index, so this list is maintained by hand from
 * https://kie.ai/market and the per-model pages under
 * https://docs.kie.ai/market/.
 *
 * RULE FOR ADDING A MODEL: open that model's own docs page and copy the `model`
 * string and its input field names verbatim. Do not guess parameter names.
 * kie.ai ignores unknown input keys SILENTLY - a wrong name does not error, it
 * produces a generation that quietly ignored your setting, which is much harder
 * to notice than a failure.
 *
 * Every entry below has had its input shape read off its docs page, except the
 * two marked as verified through kie.py, the client already in daily use.
 */
export const KIE_MODELS: StudioModel[] = [
  // ---------------------------------------------------------------- images
  {
    id: 'kie:nano-banana-2',
    provider: 'kie',
    // Not vendor-namespaced, unlike most entries. Taken from its docs page -
    // do not "correct" this to google/nano-banana-2.
    providerModel: 'nano-banana-2',
    title: 'Nano Banana 2',
    description: 'Latest Google image model. Up to 4K, accepts references.',
    capability: 'image',
    mode: 'text-to-image',
    docs: 'https://docs.kie.ai/market/google/nanobanana2',
    fields: [
      {
        name: 'prompt',
        label: 'Prompt',
        type: 'textarea',
        required: true,
        maxLength: 20000,
        placeholder: 'Describe the image you want',
      },
      {
        name: 'image_input',
        label: 'Reference images',
        type: 'media',
        accept: 'image',
        max: 14,
        description: 'Optional. Images to guide style or subject.',
      },
      {
        name: 'resolution',
        label: 'Resolution',
        type: 'select',
        default: '1K',
        options: [
          { value: '1K', label: '1K' },
          { value: '2K', label: '2K' },
          { value: '4K', label: '4K' },
        ],
      },
      {
        name: 'output_format',
        label: 'Format',
        type: 'select',
        default: 'png',
        options: [
          { value: 'png', label: 'PNG' },
          { value: 'jpg', label: 'JPG' },
        ],
      },
    ],
    aspect: { field: 'aspect_ratio', vertical: '9:16', horizontal: '16:9' },
  },
  {
    id: 'kie:google/nano-banana',
    provider: 'kie',
    providerModel: 'google/nano-banana',
    title: 'Nano Banana',
    description:
      'Fast Google image model. Strong text rendering and character consistency.',
    capability: 'image',
    mode: 'text-to-image',
    docs: 'https://docs.kie.ai/market/google/nano-banana',
    fields: [
      {
        name: 'prompt',
        label: 'Prompt',
        type: 'textarea',
        required: true,
        maxLength: 5000,
        placeholder: 'Describe the image you want',
      },
      {
        name: 'output_format',
        label: 'Format',
        type: 'select',
        default: 'png',
        options: [
          { value: 'png', label: 'PNG' },
          { value: 'jpeg', label: 'JPEG' },
        ],
      },
    ],
    aspect: { field: 'aspect_ratio', vertical: '9:16', horizontal: '16:9' },
  },
  {
    id: 'kie:grok-imagine/text-to-image',
    provider: 'kie',
    providerModel: 'grok-imagine/text-to-image',
    title: 'Grok Imagine',
    description: 'Fast, stylised image generation.',
    capability: 'image',
    mode: 'text-to-image',
    // Verified through kie.py, which sends only `prompt`. No `aspect` mapping:
    // this model's aspect-ratio parameter is not on a docs page we have read,
    // and an invented key would be silently dropped.
    fields: [
      {
        name: 'prompt',
        label: 'Prompt',
        type: 'textarea',
        required: true,
        placeholder: 'Describe the image you want',
      },
    ],
  },

  // ---------------------------------------------------------------- videos
  {
    id: 'kie:kling-2.6/text-to-video',
    provider: 'kie',
    providerModel: 'kling-2.6/text-to-video',
    title: 'Kling 2.6',
    description: 'Video straight from a prompt. Optional generated audio.',
    capability: 'video',
    mode: 'text-to-video',
    docs: 'https://docs.kie.ai/market/kling/text-to-video',
    fields: [
      {
        name: 'prompt',
        label: 'Prompt',
        type: 'textarea',
        required: true,
        maxLength: 1000,
        placeholder: 'Describe the scene and the motion',
      },
      {
        name: 'duration',
        label: 'Duration',
        type: 'select',
        default: '5',
        // A string here, unlike the image-to-video variant below. Per its docs.
        options: [
          { value: '5', label: '5 seconds' },
          { value: '10', label: '10 seconds' },
        ],
      },
      {
        name: 'sound',
        label: 'Generate audio',
        type: 'boolean',
        default: false,
      },
    ],
    aspect: { field: 'aspect_ratio', vertical: '9:16', horizontal: '16:9' },
  },
  {
    id: 'kie:kling-2.6/image-to-video',
    provider: 'kie',
    providerModel: 'kling-2.6/image-to-video',
    title: 'Kling 2.6 (from image)',
    description: 'Animates a still image into video.',
    capability: 'video',
    mode: 'image-to-video',
    fields: [
      {
        name: 'prompt',
        label: 'Prompt',
        type: 'textarea',
        required: true,
        placeholder: 'Describe the motion, e.g. "camera pushes in slowly"',
      },
      {
        name: 'image_urls',
        label: 'Source image',
        type: 'media',
        accept: 'image',
        max: 1,
        required: true,
        description: 'The still frame the motion is applied to.',
      },
      {
        name: 'duration',
        label: 'Duration',
        type: 'select',
        default: '5',
        // Numeric here: kie.py sends an int to this endpoint and it works.
        coerce: 'number',
        options: [
          { value: '5', label: '5 seconds' },
          { value: '10', label: '10 seconds' },
        ],
      },
      {
        name: 'sound',
        label: 'Generate audio',
        type: 'boolean',
        default: false,
      },
    ],
  },
  {
    id: 'kie:bytedance/v1-pro-text-to-video',
    provider: 'kie',
    providerModel: 'bytedance/v1-pro-text-to-video',
    title: 'Seedance V1 Pro',
    description: 'ByteDance video model. Up to 1080p, supports shot direction.',
    capability: 'video',
    mode: 'text-to-video',
    docs: 'https://docs.kie.ai/market/bytedance/v1-pro-text-to-video',
    fields: [
      {
        name: 'prompt',
        label: 'Prompt',
        type: 'textarea',
        required: true,
        maxLength: 10000,
        placeholder:
          'Describe the scene. Shot directions like [Cut to] and [Wide shot] work.',
      },
      {
        name: 'resolution',
        label: 'Resolution',
        type: 'select',
        default: '720p',
        options: [
          { value: '480p', label: '480p' },
          { value: '720p', label: '720p' },
          { value: '1080p', label: '1080p' },
        ],
      },
      {
        name: 'duration',
        label: 'Duration',
        type: 'select',
        default: '5',
        options: [
          { value: '5', label: '5 seconds' },
          { value: '10', label: '10 seconds' },
        ],
      },
      {
        name: 'camera_fixed',
        label: 'Lock the camera',
        type: 'boolean',
        default: false,
      },
    ],
    aspect: { field: 'aspect_ratio', vertical: '9:16', horizontal: '16:9' },
  },
];
