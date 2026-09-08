'use client';

import { FC, ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import useCookie from 'react-use-cookie';

/**
 * Studio section panel.
 *
 * Deliberately mirrors the Analytics "Channels" panel
 * (platform-analytics/platform.analytics.tsx): same bg-newBgColorInner,
 * 20px padding, 260px wide, collapsing to 100px via the SAME `collapseMenu`
 * cookie, and the same chevron button (btnSimple / btnText, 24px, rotates 180
 * when collapsed). Sharing the cookie means collapsing here collapses
 * Analytics too, which is the behaviour you'd expect from one app.
 *
 * Do not swap these for hand-picked colours - the tokens follow the theme.
 */

type StudioLink = { name: string; path: string; icon: ReactNode };

const s = {
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const ico = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
} as const;

export const STUDIO_LINKS: StudioLink[] = [
  {
    name: 'Clipping',
    path: '/studio/clipping',
    icon: (
      <svg {...ico}>
        <circle cx="6" cy="6" r="3" {...s} />
        <circle cx="6" cy="18" r="3" {...s} />
        <path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" {...s} />
      </svg>
    ),
  },
  {
    name: 'Faceless Videos',
    path: '/studio/faceless',
    icon: (
      <svg {...ico}>
        <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Z" {...s} />
        <path d="M9 10h.01M15 10h.01" {...s} />
        <path d="M8 15.5h8" {...s} strokeDasharray="2 3" />
      </svg>
    ),
  },
  {
    name: 'Videos',
    path: '/studio/videos',
    icon: (
      <svg {...ico}>
        <rect x="2" y="5" width="14" height="14" rx="3" {...s} />
        <path d="m16 10 5-3v10l-5-3" {...s} />
      </svg>
    ),
  },
  {
    name: 'Thumbnail',
    path: '/studio/thumbnail',
    icon: (
      <svg {...ico}>
        <rect x="2" y="4" width="20" height="16" rx="3" {...s} />
        <path d="m10 9 5 3-5 3V9Z" {...s} />
      </svg>
    ),
  },
  {
    name: 'Images',
    path: '/studio/images',
    icon: (
      <svg {...ico}>
        <rect x="3" y="3" width="18" height="18" rx="3" {...s} />
        <circle cx="8.5" cy="8.5" r="1.5" {...s} />
        <path d="m21 15-4.5-4.5L7 20" {...s} />
      </svg>
    ),
  },
];

export const StudioSidebar: FC = () => {
  const currentPath = usePathname();
  const [collapseMenu, setCollapseMenu] = useCookie('collapseMenu', '0');
  const collapsed = collapseMenu === '1';

  return (
    <div
      className={clsx(
        'bg-newBgColorInner p-[20px] flex flex-col gap-[15px] transition-all',
        collapsed ? 'group sidebar w-[100px]' : 'w-[260px]'
      )}
    >
      <div className="flex gap-[12px] flex-col">
        <div className="flex items-center">
          <h2 className="group-[.sidebar]:hidden flex-1 text-[20px] font-[500]">
            Studio
          </h2>
          <div
            onClick={() => setCollapseMenu(collapsed ? '0' : '1')}
            className="group-[.sidebar]:rotate-[180deg] group-[.sidebar]:mx-auto text-btnText bg-btnSimple rounded-[6px] w-[24px] h-[24px] flex items-center justify-center cursor-pointer select-none"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="7"
              height="13"
              viewBox="0 0 7 13"
              fill="none"
            >
              <path
                d="M6 11.5L1 6.5L6 1.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>

        <div className="flex flex-col gap-[4px]">
          {STUDIO_LINKS.map((link) => {
            const active = currentPath?.indexOf(link.path) === 0;
            return (
              <Link
                key={link.path}
                href={link.path}
                prefetch={true}
                title={link.name}
                className={clsx(
                  'flex items-center gap-[10px] px-[10px] group-[.sidebar]:px-0 group-[.sidebar]:justify-center h-[42px] rounded-[8px] text-[14px] font-[500] hover:text-textItemFocused hover:bg-boxFocused transition-colors',
                  active
                    ? 'text-textItemFocused bg-boxFocused'
                    : 'text-textItemBlur'
                )}
              >
                <span className="shrink-0">{link.icon}</span>
                <span className="group-[.sidebar]:hidden whitespace-nowrap">
                  {link.name}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
};
