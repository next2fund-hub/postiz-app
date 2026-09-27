'use client';

import { FC, useCallback, useMemo, useState } from 'react';
import clsx from 'clsx';
import { FormProvider, useForm } from 'react-hook-form';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Button } from '@gitroom/react/form/button';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { StudioField } from '@gitroom/frontend/components/studio/studio.field';
import {
  STATUS_STYLE,
  StudioJob,
  StudioModel,
  TASK_LABEL,
  isPrimary,
} from './studio.shared';

/**
 * One model's own page: what it is, what it needs, and what you have made with
 * it. Reached by picking a card in the browser.
 */
export const StudioModelPage: FC<{
  model: StudioModel;
  jobs: StudioJob[];
  capability: 'image' | 'video';
  /** What this model charged last time YOU ran it, if ever. */
  lastCost?: number;
  balance: number | null;
  onBack: () => void;
  onQueued: () => void;
}> = ({ model, jobs, capability, lastCost, balance, onBack, onQueued }) => {
  const fetch = useFetch();
  const toaster = useToaster();
  const form = useForm();
  const [output, setOutput] = useState<'vertical' | 'horizontal'>('vertical');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const primary = useMemo(() => model.fields.filter(isPrimary), [model]);
  const advanced = useMemo(
    () => model.fields.filter((f) => !isPrimary(f)),
    [model]
  );

  // Only this model's runs - the browser already shows everything else.
  const mine = useMemo(
    () => jobs.filter((j) => j.model === model.id),
    [jobs, model.id]
  );

  const generate = useCallback(async () => {
    if (!(await form.trigger())) {
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/studio/generate', {
        method: 'POST',
        body: JSON.stringify({
          model: model.id,
          output: model.aspect ? output : undefined,
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
      onQueued();
    } finally {
      setSubmitting(false);
    }
  }, [model, output, form, onQueued]);

  return (
    <div className="flex flex-col gap-[16px]">
      <button
        type="button"
        onClick={onBack}
        className="self-start text-[13px] text-textItemBlur hover:text-textItemFocused"
      >
        &larr; All models
      </button>

      <div className="flex items-baseline gap-[10px] flex-wrap">
        <h1 className="text-[20px] font-[600] text-textItemFocused">
          {model.title}
        </h1>
        <span className="text-[10px] tracking-wide text-textItemBlur">
          {model.vendor.toUpperCase()}
        </span>
        <span className="text-[10px] px-[6px] py-[2px] rounded-[3px] bg-newColColor text-textItemBlur">
          {TASK_LABEL[model.mode] || model.mode}
        </span>
        {balance !== null && (
          <span className="ms-auto text-[11px] text-textItemBlur">
            {balance.toLocaleString()} credits left
          </span>
        )}
      </div>

      {!!model.description && (
        <div className="text-[13px] text-textItemBlur -mt-[8px]">
          {model.description}
        </div>
      )}

      {/*
        kie.ai publishes no per-model price list - only what a finished task
        actually consumed. So the estimate is your own last run, and before
        that there is honestly nothing to show.
      */}
      <div className="text-[12px] text-textItemBlur -mt-[8px]">
        {lastCost === undefined
          ? 'Cost is shown after your first run - the provider reports it per generation.'
          : `Your last run cost ${lastCost} credits.`}
      </div>

      <div className="flex gap-[20px] flex-col xl:flex-row">
        <div className="flex-1 p-[20px] rounded-[12px] bg-newBgColorInner border border-newTableBorder">
          <FormProvider {...form}>
            <form
              onSubmit={form.handleSubmit(generate)}
              className="flex flex-col gap-[14px]"
            >
              {primary.map((f) => (
                <StudioField key={`${model.id}-${f.name}`} field={f} />
              ))}

              {!!model.aspect && (
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

              {!!advanced.length && (
                <div className="flex flex-col gap-[12px]">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((s) => !s)}
                    className="self-start text-[12px] text-textItemBlur hover:text-textItemFocused"
                  >
                    {showAdvanced ? '▾' : '▸'} Advanced ({advanced.length})
                  </button>
                  {showAdvanced &&
                    advanced.map((f) => (
                      <StudioField key={`${model.id}-${f.name}`} field={f} />
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

        <div className="xl:w-[320px] flex flex-col gap-[10px] p-[20px] rounded-[12px] bg-newBgColorInner border border-newTableBorder h-fit">
          <div className="text-[13px] font-[500]">Your runs</div>

          {!mine.length && (
            <div className="text-[12px] text-textItemBlur">
              Nothing from this model yet.
            </div>
          )}

          {mine.map((job) => (
            <div
              key={job.id}
              className="flex flex-col gap-[6px] p-[9px] rounded-[8px] border border-newTableBorder"
            >
              <span
                className={clsx(
                  'self-start text-[10px] px-[6px] py-[2px] rounded-[4px]',
                  STATUS_STYLE[job.status]
                )}
              >
                {job.status}
              </span>

              {!!job.prompt && (
                <div className="text-[11px] text-textItemBlur line-clamp-2">
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
                    alt={job.prompt || ''}
                    className="w-full rounded-[6px]"
                  />
                ))}

              {job.status === 'SUCCESS' && (
                <div className="text-[11px] text-textItemBlur">
                  Saved to your Media library
                  {typeof job.creditsConsumed === 'number'
                    ? ` · ${job.creditsConsumed} credits`
                    : ''}
                  .
                </div>
              )}

              {job.status === 'FAILED' && (
                <div className="text-[11px] text-red-300">{job.error}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
