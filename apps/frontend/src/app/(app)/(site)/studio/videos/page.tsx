import { StudioGenerator } from '@gitroom/frontend/components/studio/studio.generator';
import { Metadata } from 'next';
import { isGeneralServerSide } from '@gitroom/helpers/utils/is.general.server.side';

export const metadata: Metadata = {
  title: `${isGeneralServerSide() ? 'Postiz' : 'Gitroom'} Studio - Videos`,
  description: '',
};

export default async function Page() {
  return <StudioGenerator capability="video" title="Videos" />;
}
