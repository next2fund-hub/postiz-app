import {
  StudioModel,
  StudioOutput,
  StudioProviderId,
} from '@gitroom/nestjs-libraries/studio/studio.types';

export interface StudioSubmitResult {
  /** Provider-side task id, stored so polling can resume after a restart. */
  externalId: string;
}

export interface StudioPollResult {
  state: 'running' | 'success' | 'failed';
  resultUrls?: string[];
  error?: string;
}

/**
 * A generation backend.
 *
 * Every provider worth using has the same shape - submit a task, get an id,
 * poll or receive a callback - so the worker can drive any of them without
 * knowing which one it has. Crucially, `submit` and `poll` are SEPARATE: the
 * existing Veo3 integration blocks inside one HTTP request for the whole
 * generation, which strands the result when a proxy times the request out.
 */
export abstract class StudioProvider {
  abstract readonly id: StudioProviderId;

  /** False when the provider's credentials are absent; hides its models. */
  abstract isConfigured(): boolean;

  abstract submit(
    model: StudioModel,
    params: Record<string, any>,
    output?: StudioOutput,
    callbackUrl?: string
  ): Promise<StudioSubmitResult>;

  abstract poll(externalId: string): Promise<StudioPollResult>;
}
