import { StudioPlaceholder } from '@gitroom/frontend/components/new-layout/studio.placeholder';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Studio - Videos`,
  description: '',
};

export default async function Page() {
  return <StudioPlaceholder section="Videos" />;
}
