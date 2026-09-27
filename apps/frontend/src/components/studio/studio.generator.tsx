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
  'text-to-image': 'From a prompt',
  'image-to-image': 'From an image',
  'text-to-video': 'From a prompt',
  'image-to-video': 'From an image',
};

const STATUS_STYLE: Record<string, string> = {
  QUEUED: 'bg-newColColor text-textItemBlur',
  RUNNING: 'bg-newColColor text-textItemFocused',
  SUCCESS: 'bg-green-900/40 text-green-300',
  FAILED: 'bg-red-900/40 text-red-300',
  CANCELLED: 'bg-newColColor text-textItemBlur',
};

/**
 * A model's headline inputs: the prompt, and a source image when the model
 * cannot run without one. Everything else - seed, resolution, safety toggles,
 * camera locks - is real but secondary, and putting all of it on screen at once
 * is what made the first version of this page read as an API browser rather
 * than a tool.
 */
const isPrimary = (f: StudioFieldSpec) =>
  f.name === 'prompt' || (f.type === 'media' && !!f.required);

/**
 * A stable colour per model, so the grid is scannable before any of the tiles
 * have real output in them. Derived from the id, so a model keeps its colour.
 */
const hueOf = (id: string) => {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) % 360;
  }
  return h;
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
  const [showAdvanced, setShowAdvanced] = useState(false);
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

  const selected = useMemo(
    () => available.find((m) => m.id === modelId) || filtered[0] || available[0],
    [available, filtered, modelId]
  );

  /**
   * Thumbnails come from your own history: the most recent finished job for a
   * model becomes that model's tile. kie.ai's docs carry no per-model sample
   * images, so rather than fake them the grid starts plain and fills in with
   * your actual work as you use it.
   */
  const thumbs = useMemo(() => {
    const map = new Map<string, string>();
    for (const job of jobs || []) {
      const url = job.resultUrls?.[0];
      if (job.status === 'SUCCESS' && url && !map.has(job.model)) {
        map.set(job.model, url);
      }
    }
    return map;
  }, [jobs]);

  const primaryFields = useMemo(
    () => (selected?.fields || []).filter(isPrimary),
    [selected]
  );
  const advancedFields = useMemo(
    () => (selected?.fields || []).filter((f) => !isPrimary(f)),
    [selected]
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
      <div className="flex items-center gap-[16px] flex-wrap">
        <h1 className="text-[24px] font-[600] text-textItemFocused">{title}</h1>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models"
          className="h-[36px] px-[12px] min-w-[220px] rounded-[8px] bg-newBgColorInner border border-newTableBorder text-[14px] outline-none"
        />
        <div className="text-[12px] text-textItemBlur">
          {filtered.length} of {available.length}
        </div>
      </div>

      <div className="flex gap-[20px] flex-col xl:flex-row">
        <div className="flex-1 flex flex-col gap-[20px]">
          {/* Model grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 2xl:grid-cols-4 gap-[12px] max-h-[330px] overflow-y-auto pe-[4px]">
            {filtered.map((m) => {
              const thumb = thumbs.get(m.id);
              const active = selected?.id === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  title={m.description}
                  onClick={() => {
                    setModelId(m.id);
                    setShowAdvanced(false);
                    form.reset({});
                  }}
                  className={clsx(
                    'text-start rounded-[10px] overflow-hidden border transition-colors',
                    active
                      ? 'border-forth'
                      : 'border-newTableBorder hover:border-forth/50'
                  )}
                >
                  <div className="aspect-[4/3] w-full relative bg-newColColor">
                    {thumb ? (
                      capability === 'video' ? (
                        <video
                          src={thumb}
                          muted
                          playsInline
                          preload="metadata"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <img
                          src={thumb}
                          alt=""
                          className="w-full h-full object-cover"
                        />
                      )
                    ) : (
                      <div
                        className="w-full h-full"
                        style={{
                          background: `linear-gradient(135deg, hsl(${hueOf(
                            m.id
                          )} 45% 26%), hsl(${(hueOf(m.id) + 40) % 360} 45% 16%))`,
                        }}
                      />
                    )}
                    <div className="absolute bottom-[6px] start-[6px] text-[10px] px-[6px] py-[2px] rounded-[4px] bg-black/55 text-white">
                      {MODE_LABEL[m.mode] || m.mode}
                    </div>
                  </div>
                  <div
                    className={clsx(
                      'px-[10px] py-[8px] text-[13px] font-[500] truncate',
                      active ? 'text-textItemFocused' : 'text-textItemBlur'
                    )}
                  >
                    {m.title}
                  </div>
                </button>
              );
            })}
            {!filtered.length && (
              <div className="text-[13px] text-textItemBlur">
                No model matches that search.
              </div>
            )}
          </div>

          {/* Parameters for the selected model */}
          {!!selected && (
            <div className="flex flex-col gap-[14px] p-[20px] rounded-[12px] bg-newBgColorInner border border-newTableBorder">
              <div>
                <div className="text-[15px] font-[600] text-textItemFocused">
                  {selected.title}
                </div>
                <div className="text-[12px] text-textItemBlur">
                  {selected.description}
                </div>
              </div>

              <FormProvider {...form}>
                <form
                  onSubmit={form.handleSubmit(generate)}
                  className="flex flex-col gap-[14px]"
                >
                  {primaryFields.map((f) => (
                    <StudioField key={`${selected.id}-${f.name}`} field={f} />
                  ))}

                  {!!selected.aspect && (
                    <div className="flex gap-[10px]">
                      <Button
                        type="button"
                        className="!flex-1"
                        onClick={() => setOutput('vertical')}
                        secondary={output === 'horizontal'}
                      >
                        Vertical
                      </Button>
                      <Button
                        type="button"
                        className="!flex-1"
                        onClick={() => setOutput('horizontal')}
                        secondary={output === 'vertical'}
                      >
                        Horizontal
                      </Button>
                    </div>
                  )}

                  {!!advancedFields.length && (
                    <div className="flex flex-col gap-[12px]">
                      <button
                        type="button"
                        onClick={() => setShowAdvanced((s) => !s)}
                        className="self-start text-[13px] text-textItemBlur hover:text-textItemFocused"
                      >
                        {showAdvanced ? '▾' : '▸'} Advanced (
                        {advancedFields.length})
                      </button>
                      {showAdvanced &&
                        advancedFields.map((f) => (
                          <StudioField
                            key={`${selected.id}-${f.name}`}
                            field={f}
                          />
                        ))}
                    </div>
                  )}

                  <Button type="submit" disabled={submitting}>
                    {submitting ? 'Queueing...' : 'Generate'}
                  </Button>

                  <div className="text-[12px] text-textItemBlur">
                    Runs in the background. You can leave this page.
                  </div>
                </form>
              </FormProvider>
            </div>
          )}
        </div>

        {/* Job history */}
        <div className="xl:w-[340px] flex flex-col gap-[12px] p-[20px] rounded-[12px] bg-newBgColorInner border border-newTableBorder h-fit">
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
