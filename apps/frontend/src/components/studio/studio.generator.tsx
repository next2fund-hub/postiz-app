'use client';

import { FC, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { StudioBrowser } from '@gitroom/frontend/components/studio/studio.browser';
import { StudioModelPage } from '@gitroom/frontend/components/studio/studio.model';
import {
  StudioJob,
  StudioModel,
} from '@gitroom/frontend/components/studio/studio.shared';

/**
 * Studio, in two views: browse the catalogue, then work with one model.
 *
 * Kept as a view switch rather than a route because a model id looks like
 * "kie:google/nano-banana" - embedding that in a path means encoding slashes
 * and colons, and getting it wrong 404s the page.
 */
export const StudioGenerator: FC<{
  capability: 'image' | 'video';
  title: string;
}> = ({ capability, title }) => {
  const fetch = useFetch();
  const [modelId, setModelId] = useState<string>('');

  const { data: models, isLoading } = useSWR<StudioModel[]>(
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
      // Poll only while something is in flight, so an idle tab stays quiet.
      refreshInterval: (latest) =>
        (latest || []).some(
          (j) => j.status === 'QUEUED' || j.status === 'RUNNING'
        )
          ? 5000
          : 0,
    }
  );

  const { data: credits } = useSWR<{ kie: number | null }>(
    'studio-credits',
    async () => await (await fetch('/studio/credits')).json(),
    { revalidateOnFocus: false }
  );

  const available = useMemo(
    () => (models || []).filter((m) => m.available),
    [models]
  );

  /**
   * Thumbnails and typical cost both come from your own history - the most
   * recent finished run of a model supplies its tile, and its real charge.
   * kie.ai publishes neither sample images nor a per-model price list, so
   * inventing either would mean showing you numbers that are not true.
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

  const costs = useMemo(() => {
    const map = new Map<string, number>();
    for (const job of jobs || []) {
      if (
        job.status === 'SUCCESS' &&
        typeof job.creditsConsumed === 'number' &&
        !map.has(job.model)
      ) {
        map.set(job.model, job.creditsConsumed);
      }
    }
    return map;
  }, [jobs]);

  const selected = available.find((m) => m.id === modelId);

  if (isLoading) {
    return (
      <div className="text-[14px] text-textItemBlur">Loading models...</div>
    );
  }

  if (!available.length) {
    return (
      <div className="flex flex-col gap-[16px]">
        <h1 className="text-[20px] font-[600] text-textColor">{title}</h1>
        <div className="p-[24px] rounded-[12px] bg-newBgColorInner border border-newTableBorder text-[14px] text-textItemBlur">
          No {capability} models are available. Each model needs its provider
          API key set on the server.
          {!!models?.length && (
            <>
              {' '}
              {models.length} model{models.length > 1 ? 's are' : ' is'} in the
              catalog but unavailable &mdash; set{' '}
              <code className="text-textColor">KIEAI_API_KEY</code> to
              enable kie.ai.
            </>
          )}
        </div>
      </div>
    );
  }

  if (selected) {
    return (
      <StudioModelPage
        model={selected}
        jobs={jobs || []}
        capability={capability}
        lastCost={costs.get(selected.id)}
        balance={credits?.kie ?? null}
        onBack={() => setModelId('')}
        onQueued={mutate}
      />
    );
  }

  return (
    <StudioBrowser
      models={available}
      thumbs={thumbs}
      costs={costs}
      balance={credits?.kie ?? null}
      capability={capability}
      onPick={setModelId}
    />
  );
};
