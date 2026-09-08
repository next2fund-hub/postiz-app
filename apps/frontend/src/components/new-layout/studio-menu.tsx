'use client';

import { FC, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import Link from 'next/link';

/**
 * Studio - a sidebar item that opens a flyout instead of navigating.
 *
 * Styling is copied verbatim from MenuItem (menu-item.tsx) so the trigger is
 * pixel-identical to Calendar / Media / Plugs: same 54px box, same 12px radius,
 * same textItemFocused / textItemBlur / boxFocused theme tokens. Do not
 * hand-pick colours here - use the tokens so it follows light/dark like the
 * rest of the nav.
 */

type StudioLink = { name: string; path: string; icon: ReactNode };

const iconProps = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
} as const;

// Sub-item icons: same visual language as the sidebar set - 1.8 stroke,
// currentColor, rounded caps.
const stroke = {
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const STUDIO_LINKS: StudioLink[] = [
  {
    name: 'Clipping',
    path: '/studio/clipping',
    icon: (
      <svg {...iconProps}>
        <circle cx="6" cy="6" r="3" {...stroke} />
        <circle cx="6" cy="18" r="3" {...stroke} />
        <path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" {...stroke} />
      </svg>
    ),
  },
  {
    name: 'Faceless Videos',
    path: '/studio/faceless',
    icon: (
      <svg {...iconProps}>
        <path
          d="M9 10h.01M15 10h.01M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z"
          {...stroke}
        />
        <path d="M8 15.5h8" {...stroke} strokeDasharray="2 3" />
      </svg>
    ),
  },
  {
    name: 'Videos',
    path: '/studio/videos',
    icon: (
      <svg {...iconProps}>
        <rect x="2" y="5" width="14" height="14" rx="3" {...stroke} />
        <path d="m16 10 5-3v10l-5-3" {...stroke} />
      </svg>
    ),
  },
  {
    name: 'Thumbnail',
    path: '/studio/thumbnail',
    icon: (
      <svg {...iconProps}>
        <rect x="2" y="4" width="20" height="16" rx="3" {...stroke} />
        <path d="m10 9 5 3-5 3V9Z" {...stroke} />
      </svg>
    ),
  },
  {
    name: 'Images',
    path: '/studio/images',
    icon: (
      <svg {...iconProps}>
        <rect x="3" y="3" width="18" height="18" rx="3" {...stroke} />
        <circle cx="8.5" cy="8.5" r="1.5" {...stroke} />
        <path d="m21 15-4.5-4.5L7 20" {...stroke} />
      </svg>
    ),
  },
];

export const StudioMenu: FC = () => {
  const currentPath = usePathname();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const isActive = currentPath?.indexOf('/studio') === 0;

  // Close on outside click and on Escape. Without this the flyout stays open
  // when you click elsewhere in the app, which feels broken.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Navigating away should dismiss it.
  useEffect(() => setOpen(false), [currentPath]);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  return (
    <div className="relative w-full" ref={wrapRef}>
      <button
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={open}
        className={clsx(
          'w-full h-[54px] py-[8px] px-[6px] gap-[4px] flex flex-col text-[10px] font-[600] items-center justify-center rounded-[12px] hover:text-textItemFocused hover:bg-boxFocused',
          isActive || open
            ? 'text-textItemFocused bg-boxFocused'
            : 'text-textItemBlur'
        )}
      >
        <div>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="21"
            height="21"
            viewBox="0 0 24 24"
            fill="none"
          >
            {/* wand + sparkles: reads as "make something" across video and image */}
            <path d="M15 4 4 15l5 5L20 9l-5-5Z" {...stroke} />
            <path d="M13.5 5.5 18.5 10.5" {...stroke} />
            <path d="M5 4V0.5M5 4v3.5M3.25 4h3.5M18 16v-2.5M18 16v2.5M16.25 16h3.5" {...stroke} />
          </svg>
        </div>
        <div className="text-[10px]">Studio</div>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute z-[200] start-[calc(100%+10px)] top-0 min-w-[186px] p-[6px] rounded-[12px] bg-newBgColorInner border border-newTableBorder shadow-lg"
        >
          {STUDIO_LINKS.map((link) => {
            const active = currentPath?.indexOf(link.path) === 0;
            return (
              <Link
                key={link.path}
                href={link.path}
                prefetch={true}
                role="menuitem"
                onClick={() => setOpen(false)}
                className={clsx(
                  'flex items-center gap-[10px] px-[10px] h-[38px] rounded-[8px] text-[12px] font-[600] whitespace-nowrap hover:text-textItemFocused hover:bg-boxFocused',
                  active ? 'text-textItemFocused bg-boxFocused' : 'text-textItemBlur'
                )}
              >
                <span className="shrink-0">{link.icon}</span>
                <span>{link.name}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
};
