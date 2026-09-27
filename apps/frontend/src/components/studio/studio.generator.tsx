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
  providerModel: string;
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

const MODE_LABEL: Record<string, string> = {
  'text-to-image': 'Image from a prompt',
  'image-to-image': 'Image from an image',
  'text-to-video': 'Video from a prompt',
  'image-to-video': 'Video from an image',
};

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
  const [query, setQuery] = useState('');
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return available;
    }
    return available.filter((m) =>
      `${m.title} ${m.description} ${m.providerModel}`.toLowerCase().includes(q)
    );
  }, [available, query]);

  // Group by what the model needs from you, which is the question people
  // actually have - "can I make this from just a prompt?" - rather than by
  // vendor, which only matters once you already know what you want.
  const grouped = useMemo(() => {
    const order = [
      'text-to-image',
      'image-to-image',
      'text-to-video',
      'image-to-video',
    ];
    const buckets = new Map<string, StudioModel[]>();
    for (const m of filtered) {
      const label = MODE_LABEL[m.mode] || m.mode;
      buckets.set(label, [...(buckets.get(label) || []), m]);
    }
    return [...buckets.entries()].sort(
      (a, b) =>
        order.findIndex((o) => MODE_LABEL[o] === a[0]) -
        order.findIndex((o) => MODE_LABEL[o] === b[0])
    );
  }, [filtered]);

  const selected = useMemo(
    () => available.find((m) => m.id === modelId) || filtered[0] || available[0],
    [available, filtered, modelId]
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
            <div className="flex items-center gap-[10px]">
              <div className="text-[14px] font-[500]">Model</div>
              <div className="text-[12px] text-textItemBlur">
                {filtered.length} of {available.length}
              </div>
            </div>

            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models, e.g. kling, seedream, 4k"
              className="w-full h-[38px] px-[12px] rounded-[8px] bg-newColColor border border-newTableBorder text-[14px] outline-none"
            />

            {/* 130+ models do not fit on a page. Scroll the list, not the form. */}
            <div className="max-h-[280px] overflow-y-auto flex flex-col gap-[10px] pe-[4px]">
              {grouped.map(([group, items]) => (
                <div key={group} className="flex flex-col gap-[4px]">
                  <div className="text-[11px] uppercase tracking-wide text-textItemBlur">
                    {group}
                  </div>
                  {items.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setModelId(m.id);
                        form.reset({});
                      }}
                      className={clsx(
                        'text-start px-[10px] py-[7px] rounded-[6px] border transition-colors',
                        selected?.id === m.id
                          ? 'border-newTableBorder bg-boxFocused text-textItemFocused'
                          : 'border-transparent text-textItemBlur hover:bg-boxFocused hover:text-textItemFocused'
                      )}
                    >
                      <div className="text-[13px] font-[500]">{m.title}</div>
                    </button>
                  ))}
                </div>
              ))}
              {!filtered.length && (
                <div className="text-[13px] text-textItemBlur">
                  No model matches that search.
                </div>
              )}
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
