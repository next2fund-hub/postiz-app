import { StudioModel } from '@gitroom/nestjs-libraries/studio/studio.types';

/**
 * kie.ai model catalog.
 *
 * kie.ai exposes ~50 models through ONE endpoint (/api/v1/jobs/createTask),
 * switched by the `model` string. It publishes no machine-readable model index,
 * so this list is maintained by hand from https://kie.ai/market and the
 * per-model pages under https://docs.kie.ai/market/.
 *
 * RULE FOR ADDING A MODEL: copy the `model` string and its input field names
 * from that model's own docs page. Do not guess parameter names - kie.ai
 * ignores unknown input keys silently, so a wrong name does not error, it just
 * produces a generation that quietly ignored your setting.
 *
 * Every entry below has had its input shape verified: the two defaults come
 * from tools/../kie.py, which is in daily use, and nano-banana from its docs
 * page. Fields that were not verified are omitted rather than assumed.
 */
export const KIE_MODELS: StudioModel[] = [
  {
    id: 'kie:google/nano-banana',
    provider: 'kie',
    providerModel: 'google/nano-banana',
    title: 'Nano Banana',
    description:
      "Google's fast image model. Strong text rendering and character consistency.",
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
    // No `aspect`: this model's aspect-ratio parameter is not documented on a
    // page we have checked, and an invented key would be silently dropped.
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
  {
    id: 'kie:kling-2.6/image-to-video',
    provider: 'kie',
    providerModel: 'kling-2.6/image-to-video',
    title: 'Kling 2.6',
    description: 'Animates a still image into video. Optional generated audio.',
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
        coerce: 'number',
        options: [
          { value: '5', label: '5 seconds' },
          { value: '10', label: '10 seconds' },
        ],
      },
      { name: 'sound', label: 'Generate audio', type: 'boolean', default: false },
    ],
  },
];
