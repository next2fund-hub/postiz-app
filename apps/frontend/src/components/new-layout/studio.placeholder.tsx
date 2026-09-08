'use client';

import { FC } from 'react';
import { STUDIO_LINKS } from '@gitroom/frontend/components/new-layout/studio.sidebar';

/**
 * Placeholder shell for the Studio sections.
 *
 * The nav and routing land first so the structure is real and clickable; each
 * tool gets implemented behind its own route. Clipping is furthest along - the
 * pipeline already works from the command line (see tools/clip.py) and only
 * needs a job endpoint plus this UI wired to it.
 */
export const StudioPlaceholder: FC<{ section: string }> = ({ section }) => {
  const link = STUDIO_LINKS.find((l) => l.name === section);

  return (
    <div className="flex flex-col gap-[16px]">
      <div className="flex items-center gap-[12px]">
        <span className="text-textItemFocused">{link?.icon}</span>
        <h1 className="text-[24px] font-[600] text-textItemFocused">{section}</h1>
      </div>
      <div className="p-[24px] rounded-[12px] bg-newBgColorInner border border-newTableBorder">
        <div className="text-[14px] text-textItemBlur">
          Not built yet. Output will save into your Media library, ready to
          schedule like any other asset.
        </div>
      </div>
    </div>
  );
};
