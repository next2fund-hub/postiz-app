import { Injectable } from '@nestjs/common';
import {
  StudioProvider,
  StudioPollResult,
  StudioSubmitResult,
} from '@gitroom/nestjs-libraries/studio/providers/studio.provider';
import {
  StudioModel,
  StudioOutput,
  StudioProviderId,
} from '@gitroom/nestjs-libraries/studio/studio.types';

const BASE = 'https://api.kie.ai/api/v1/jobs';

/**
 * kie.ai, via its unified Jobs API.
 *
 * Note this is NOT the endpoint the legacy Veo3 integration uses. That one
 * calls /api/v1/veo/generate, which is model-specific and pinned to veo3_fast.
 * /api/v1/jobs/createTask takes the model as a parameter, which is what makes a
 * catalog possible at all.
 *
 * The response shape here matches the client in the content workspace's kie.py,
 * which is in daily use - including the detail that `resultJson` arrives as a
 * JSON *string* that has to be parsed again.
 */
@Injectable()
export class KieProvider extends StudioProvider {
  readonly id: StudioProviderId = 'kie';

  /**
   * Postiz's own Veo3 integration reads KIEAI_API_KEY, but the same secret is
   * conventionally called KIE_API_KEY elsewhere. Accept either: one missing
   * "AI" should not silently empty the model list.
   */
  private key() {
    return process.env.KIEAI_API_KEY || process.env.KIE_API_KEY || '';
  }

  isConfigured() {
    return !!this.key();
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.key()}`,
    };
  }

  /** Catalog params -> the provider's `input` object. */
  private buildInput(
    model: StudioModel,
    params: Record<string, any>,
    output?: StudioOutput
  ) {
    const input: Record<string, any> = {};

    for (const field of model.fields) {
      const value = params[field.name];
      if (value === undefined || value === null || value === '') {
        continue;
      }

      if (field.type === 'select' && field.coerce === 'number') {
        input[field.name] = Number(value);
        continue;
      }

      if (field.type === 'media') {
        // The form yields media objects; kie.ai wants public URLs.
        const urls = (Array.isArray(value) ? value : [value])
          .map((v: any) => (typeof v === 'string' ? v : v?.path))
          .filter(Boolean);
        if (urls.length) {
          input[field.name] = urls.slice(0, field.max ?? urls.length);
        }
        continue;
      }

      input[field.name] = value;
    }

    if (model.aspect && output) {
      input[model.aspect.field] = model.aspect[output];
    }

    return input;
  }

  async submit(
    model: StudioModel,
    params: Record<string, any>,
    output?: StudioOutput,
    callbackUrl?: string
  ): Promise<StudioSubmitResult> {
    const body: Record<string, any> = {
      model: model.providerModel,
      input: this.buildInput(model, params, output),
    };

    if (callbackUrl) {
      body.callBackUrl = callbackUrl;
    }

    const res = await fetch(`${BASE}/createTask`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    const json: any = await res.json().catch(() => ({}));
    if (json?.code !== 200 || !json?.data?.taskId) {
      throw new Error(
        `kie.ai rejected the task: ${json?.msg || `HTTP ${res.status}`}`
      );
    }

    return { externalId: json.data.taskId };
  }

  /**
   * Remaining credits on the account.
   *
   * Note this is the ACCOUNT balance, not a price list - kie.ai publishes no
   * per-model pricing endpoint, only what a finished task consumed.
   */
  async balance(): Promise<number | null> {
    try {
      const res = await fetch('https://api.kie.ai/api/v1/chat/credit', {
        headers: this.headers(),
      });
      const json: any = await res.json().catch(() => ({}));
      return json?.code === 200 && typeof json.data === 'number'
        ? json.data
        : null;
    } catch {
      return null;
    }
  }

  async poll(externalId: string): Promise<StudioPollResult> {
    const res = await fetch(
      `${BASE}/recordInfo?taskId=${encodeURIComponent(externalId)}`,
      { headers: this.headers() }
    );

    const json: any = await res.json().catch(() => ({}));
    if (json?.code !== 200) {
      // A transient read failure is not a failed generation. Stay in `running`
      // and let the worker's attempt budget decide when to give up - otherwise
      // one blip discards a video that is still rendering.
      return { state: 'running' };
    }

    const data = json.data || {};

    if (data.state === 'success') {
      let urls: string[] = [];
      try {
        urls = JSON.parse(data.resultJson || '{}').resultUrls || [];
      } catch {
        return { state: 'failed', error: 'Could not parse the provider result' };
      }
      const creditsConsumed =
        typeof data.creditsConsumed === 'number' ? data.creditsConsumed : undefined;

      return urls.length
        ? { state: 'success', resultUrls: urls, creditsConsumed }
        : { state: 'failed', error: 'Provider reported success but returned no files' };
    }

    if (data.state === 'fail') {
      return {
        state: 'failed',
        error: data.failMsg || data.failCode || 'Generation failed',
      };
    }

    return { state: 'running' };
  }
}
