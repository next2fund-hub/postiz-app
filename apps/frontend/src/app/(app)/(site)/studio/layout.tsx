import { StudioSidebar } from '@gitroom/frontend/components/new-layout/studio.sidebar';

/**
 * The (site) layout renders children into `flex flex-1 gap-[1px]`, so a page
 * can emit a panel + content pair as siblings - the same way PlatformAnalytics
 * does. Every /studio/* route therefore gets the section panel for free.
 */
export default async function Layout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <StudioSidebar />
      <div className="bg-newBgColorInner flex-1 flex-col flex p-[20px] gap-[12px]">
        {children}
      </div>
    </>
  );
}
