'use client';

import { FC, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import clsx from 'clsx';
import { FormProvider, useForm } from 'react-hook-form';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import {
  StudioField,
  StudioFieldSpec,
} from '@gitroom/frontend/components/studio/studio.field';

interface StudioModel {
  id: string;
  provider: string;
  title: string;
  description: string;
  capability: 'image' | 'video';
  mode: string;
  fields: StudioFieldSpec[];
  aspect?: { field: string; vertical: string; horizontal: string };
  available: boolean;
  docs?: string;
}

interface StudioJob {
  id: string;
  model: string;
  capability: string;
  status: 'QUEUED' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED';
  prompt?: string;
  resultUrls?: string[];
  error?: string;
  createdAt: string;
}

const STATUS_STYLE: Record<string, string> = {
  QUEUED: 'bg-newColColor text-textItemBlur',
  RUNNING: 'bg-newColColor text-textItemFocused',
  SUCCESS: 'bg-green-900/40 text-green-300',
  FAILED: 'bg-red-900/40 text-red-300',
  CANCELLED: 'bg-newColColor text-textItemBlur',
};

export const StudioGenerator: FC<{
  capability: 'image' | 'video';
  title: string;
}> = ({ capability, title }) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const form = useForm();
  const [modelId, setModelId] = useState<string>('');
  const [output, setOutput] = useState<'vertical' | 'horizontal'>('vertical');
  const [submitting, setSubmitting] = useState(false);

  const { data: models, isLoading: loadingModels } = useSWR<StudioModel[]>(
    `studio-models-${capability}`,
    async () =>
      await (await fetch(`/studio/models?capability=${capability}`)).json(),
    { revalidateOnFocus: false }
  );

  const loadJobs = useCallback(
    async () =>
      await (await fetch(`/studio/jobs?capability=${capability}`)).json(),
    [capability]
  );

  const { data: jobs, mutate } = useSWR<StudioJob[]>(
    `studio-jobs-${capability}`,
    loadJobs,
    {
      // Only poll while something is actually in flight, so an idle Studio tab
      // is not hammering the API every few seconds.
      refreshInterval: (latest) =>
        (latest || []).some(
          (j) => j.status === 'QUEUED' || j.status === 'RUNNING'
        )
          ? 5000
          : 0,
    }
  );

  const available = useMemo(
    () => (models || []).filter((m) => m.available),
    [models]
  );

  const selected = useMemo(
    () => available.find((m) => m.id === modelId) || available[0],
    [available, modelId]
  );

  const generate = useCallback(async () => {
    if (!selected) {
      return;
    }
    if (!(await form.trigger())) {
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/studio/generate', {
        method: 'POST',
        body: JSON.stringify({
          model: selected.id,
          output: selected.aspect ? output : undefined,
          params: form.getValues(),
        }),
      });

      if (res.status !== 200 && res.status !== 201) {
        const body = await res.json().catch(() => ({}));
        const message = Array.isArray(body?.message)
          ? body.message.join(', ')
          : body?.message || 'Could not start the generation';
        toaster.show(message, 'warning');
        return;
      }

      toaster.show('Generation queued', 'success');
      mutate();
    } finally {
      setSubmitting(false);
    }
  }, [selected, output, form, mutate]);

  if (loadingModels) {
    return (
      <div className="text-[14px] text-textItemBlur">Loading models...</div>
    );
  }

  // An empty catalog is nearly always a missing API key. Say so, rather than
  // rendering a blank page - that ambiguity is exactly what made the missing
  // KIEAI_API_KEY slow to diagnose.
  if (!available.length) {
    return (
      <div className="flex flex-col gap-[16px]">
        <h1 className="text-[24px] font-[600] text-textItemFocused">{title}</h1>
        <div className="p-[24px] rounded-[12px] bg-newBgColorInner border border-newTableBorder text-[14px] text-textItemBlur">
          No {capability} models are available. Each model needs its provider
          API key set on the server.
          {!!models?.length && (
            <>
              {' '}
              {models.length} model{models.length > 1 ? 's are' : ' is'} in the
              catalog but unavailable &mdash; set{' '}
              <code className="text-textItemFocused">KIEAI_API_KEY</code> to
              enable kie.ai.
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[20px]">
      <h1 className="text-[24px] font-[600] text-textItemFocused">{title}</h1>

      <div className="flex gap-[20px] flex-col xl:flex-row">
        <div className="flex-1 flex flex-col gap-[16px] p-[20px] rounded-[12px] bg-newBgColorInner border border-newTableBorder">
          <div className="flex flex-col gap-[8px]">
            <div className="text-[14px] font-[500]">Model</div>
            <div className="flex flex-wrap gap-[8px]">
              {available.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    setModelId(m.id);
                    form.reset({});
                  }}
                  className={clsx(
                    'text-start px-[12px] py-[10px] rounded-[8px] border transition-colors',
                    selected?.id === m.id
                      ? 'border-newTableBorder bg-boxFocused text-textItemFocused'
                      : 'border-newTableBorder text-textItemBlur hover:text-textItemFocused'
                  )}
                >
                  <div className="text-[14px] font-[500]">{m.title}</div>
                  <div className="text-[12px] opacity-70 max-w-[240px]">
                    {m.description}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {!!selected && (
            <FormProvider {...form}>
              <form
                onSubmit={form.handleSubmit(generate)}
                className="flex flex-col gap-[14px]"
              >
                {!!selected.aspect && (
                  <div className="flex gap-[10px]">
                    <Button
                      type="button"
                      className="!flex-1"
                      onClick={() => setOutput('vertical')}
                      secondary={output === 'horizontal'}
                    >
                      Vertical (Stories, Reels)
                    </Button>
                    <Button
                      type="button"
                      className="!flex-1"
                      onClick={() => setOutput('horizontal')}
                      secondary={output === 'vertical'}
                    >
                      Horizontal (Feed)
                    </Button>
                  </div>
                )}

                {selected.fields.map((f) => (
                  <StudioField key={`${selected.id}-${f.name}`} field={f} />
                ))}

                <Button type="submit" disabled={submitting}>
                  {submitting ? 'Queueing...' : 'Generate'}
                </Button>

                <div className="text-[12px] text-textItemBlur">
                  Generation runs in the background. You can leave this page.
                </div>
              </form>
            </FormProvider>
          )}
        </div>

        <div className="xl:w-[380px] flex flex-col gap-[12px] p-[20px] rounded-[12px] bg-newBgColorInner border border-newTableBorder">
          <div className="text-[14px] font-[500]">Recent</div>

          {!jobs?.length && (
            <div className="text-[13px] text-textItemBlur">
              Nothing generated yet.
            </div>
          )}

          {(jobs || []).map((job) => (
            <div
              key={job.id}
              className="flex flex-col gap-[6px] p-[10px] rounded-[8px] border border-newTableBorder"
            >
              <div className="flex items-center gap-[8px]">
                <span
                  className={clsx(
                    'text-[11px] px-[6px] py-[2px] rounded-[4px]',
                    STATUS_STYLE[job.status]
                  )}
                >
                  {job.status}
                </span>
                <span className="text-[12px] text-textItemBlur truncate">
                  {job.model}
                </span>
              </div>

              {!!job.prompt && (
                <div className="text-[12px] text-textItemBlur line-clamp-2">
                  {job.prompt}
                </div>
              )}

              {job.status === 'SUCCESS' &&
                !!job.resultUrls?.length &&
                (capability === 'video' ? (
                  <video
                    src={job.resultUrls[0]}
                    controls
                    className="w-full rounded-[6px]"
                  />
                ) : (
                  <img
                    src={job.resultUrls[0]}
                    alt={job.prompt || 'Generated image'}
                    className="w-full rounded-[6px]"
                  />
                ))}

              {job.status === 'SUCCESS' && (
                <div className="text-[12px] text-textItemBlur">
                  Saved to your Media library.
                </div>
              )}

              {job.status === 'FAILED' && (
                <div className="text-[12px] text-red-300">{job.error}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
