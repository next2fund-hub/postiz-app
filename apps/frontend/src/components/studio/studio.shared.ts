import { StudioFieldSpec } from '@gitroom/frontend/components/studio/studio.field';

export interface StudioModel {
  id: string;
  provider: string;
  title: string;
  description: string;
  vendor: string;
  providerModel: string;
  capability: 'image' | 'video';
  mode: string;
  fields: StudioFieldSpec[];
  aspect?: { field: string; vertical: string; horizontal: string };
  available: boolean;
  docs?: string;
}

export interface StudioJob {
  id: string;
  model: string;
  capability: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  prompt?: string;
  resultUrls?: string[];
  creditsConsumed?: number;
  error?: string;
  createdAt: string;
}

export const TASK_LABEL: Record<string, string> = {
  'text-to-image': 'Text to Image',
  'image-to-image': 'Image to Image',
  'text-to-video': 'Text to Video',
  'image-to-video': 'Image to Video',
};

export const STATUS_STYLE: Record<string, string> = {
  QUEUED: 'bg-newColColor text-textItemBlur',
  RUNNING: 'bg-newColColor text-textItemFocused',
  SUCCESS: 'bg-green-900/40 text-green-300',
  FAILED: 'bg-red-900/40 text-red-300',
  CANCELLED: 'bg-newColColor text-textItemBlur',
};

/**
 * A model's headline inputs: the prompt, and a source image when the model
 * cannot run without one. Everything else - seed, resolution, safety toggles,
 * camera locks - is real but secondary, and showing all of it at once is what
 * made the first version of this page read as an API browser rather than a
 * tool.
 */
export const isPrimary = (f: StudioFieldSpec) =>
  f.name === 'prompt' || (f.type === 'media' && !!f.required);

/**
 * A stable colour per string, so provider dots and empty tiles are scannable
 * and a given vendor always looks the same.
 */
export const hueOf = (value: string) => {
  let h = 0;
  for (let i = 0; i < value.length; i++) {
    h = (h * 31 + value.charCodeAt(i)) % 360;
  }
  return h;
};
