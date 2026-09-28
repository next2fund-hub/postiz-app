'use client';

import { FC, useMemo, useState } from 'react';
import clsx from 'clsx';
import { StudioModel, TASK_LABEL, hueOf } from './studio.shared';

/**
 * The model browser: search, provider and task filters, and a grid of cards.
 *
 * Modelled on kie.ai's own catalogue page, which solves the same problem -
 * over a hundred models, and the user knows roughly what they want to make
 * before they know which model makes it. Filters come first, the grid second,
 * and picking a card moves you to that model's own page rather than expanding
 * a form underneath.
 */
export const StudioBrowser: FC<{
  models: StudioModel[];
  thumbs: Map<string, string>;
  costs: Map<string, number>;
  balance: number | null;
  capability: 'image' | 'video';
  onPick: (id: string) => void;
}> = ({ models, thumbs, costs, balance, capability, onPick }) => {
  const [query, setQuery] = useState('');
  const [vendors, setVendors] = useState<string[]>([]);
  const [tasks, setTasks] = useState<string[]>([]);

  const allVendors = useMemo(
    () =>
      [...new Set(models.map((m) => m.vendor))].sort((a, b) =>
        a.localeCompare(b)
      ),
    [models]
  );

  const allTasks = useMemo(
    () => [...new Set(models.map((m) => m.mode))].sort(),
    [models]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models.filter((m) => {
      if (vendors.length && !vendors.includes(m.vendor)) {
        return false;
      }
      if (tasks.length && !tasks.includes(m.mode)) {
        return false;
      }
      if (
        q &&
        !`${m.title} ${m.vendor} ${m.providerModel}`.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [models, query, vendors, tasks]);

  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const pill = (active: boolean) =>
    clsx(
      'text-[11px] px-[10px] py-[4px] rounded-full border transition-colors whitespace-nowrap',
      active
        ? 'bg-forth text-white border-forth'
        : 'border-newTableBorder text-textItemBlur hover:text-textColor'
    );

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center gap-[12px] flex-wrap">
        <h1 className="text-[20px] font-[600] text-textColor">
          All models
        </h1>
        <span className="text-[12px] text-textItemBlur">
          {filtered.length} of {models.length}
        </span>
        {balance !== null && (
          <span className="text-[11px] px-[8px] py-[3px] rounded-full bg-newColColor text-textItemBlur">
            {balance.toLocaleString()} credits left
          </span>
        )}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models by name, e.g. 'nano banana'"
          className="ms-auto h-[34px] px-[12px] w-full sm:w-[320px] rounded-full bg-newBgColorInner border border-newTableBorder text-[13px] outline-none"
        />
      </div>

      <div className="flex gap-[10px]">
        <div className="text-[10px] tracking-wide text-textItemBlur pt-[6px] w-[74px] shrink-0">
          PROVIDERS ({vendors.length}/{allVendors.length})
        </div>
        <div className="flex flex-wrap gap-[6px]">
          {allVendors.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => toggle(vendors, setVendors, v)}
              className={pill(vendors.includes(v))}
            >
              <span
                className="inline-block w-[6px] h-[6px] rounded-full me-[5px] align-middle"
                style={{ background: `hsl(${hueOf(v)} 65% 55%)` }}
              />
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-[10px]">
        <div className="text-[10px] tracking-wide text-textItemBlur pt-[6px] w-[74px] shrink-0">
          TASKS ({tasks.length}/{allTasks.length})
        </div>
        <div className="flex flex-wrap gap-[6px]">
          {allTasks.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => toggle(tasks, setTasks, t)}
              className={pill(tasks.includes(t))}
            >
              {TASK_LABEL[t] || t}
            </button>
          ))}
        </div>
      </div>

      {/*
        Scroll cap goes on this wrapper, never on the grid. A grid with a
        max-height shrinks its rows to fit instead of overflowing, which
        previously crushed every card into a ~22px colour strip.
      */}
      <div className="max-h-[calc(100vh-320px)] overflow-y-auto pe-[4px]">
        <div className="grid grid-cols-2 md:grid-cols-3 2xl:grid-cols-5 gap-[10px] auto-rows-max">
          {filtered.map((m) => {
            const thumb = thumbs.get(m.id);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => onPick(m.id)}
                title={m.description}
                className="group text-start rounded-[10px] overflow-hidden border border-newTableBorder hover:border-forth transition-colors"
              >
                <div className="aspect-[16/10] w-full relative bg-newColColor">
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
                          m.vendor
                        )} 42% 24%), hsl(${
                          (hueOf(m.vendor) + 35) % 360
                        } 42% 14%))`,
                      }}
                    />
                  )}
                  <span className="absolute top-[6px] end-[6px] text-[9px] tracking-wide px-[6px] py-[2px] rounded-full bg-black/60 text-white/90">
                    {m.vendor.toUpperCase()}
                  </span>
                </div>
                <div className="px-[9px] py-[7px]">
                  {/*
                    No vendor line here - the badge on the image already says
                    it, and repeating it pushed the vendor name onto the card
                    three times while saying nothing about the model.
                  */}
                  <div className="text-[12px] font-[600] text-textColor truncate">
                    {m.title}
                  </div>
                  <div className="text-[10px] text-textItemBlur truncate">
                    {m.description}
                  </div>
                  <div className="mt-[4px] flex items-center gap-[4px]">
                    <span className="text-[9px] px-[5px] py-[2px] rounded-[3px] bg-newColColor text-textItemBlur">
                      {TASK_LABEL[m.mode] || m.mode}
                    </span>
                    {costs.has(m.id) && (
                      <span className="text-[9px] px-[5px] py-[2px] rounded-[3px] bg-newColColor text-textItemBlur">
                        ~{costs.get(m.id)} cr
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {!filtered.length && (
          <div className="text-[13px] text-textItemBlur py-[20px]">
            No model matches those filters.
          </div>
        )}
      </div>
    </div>
  );
};
