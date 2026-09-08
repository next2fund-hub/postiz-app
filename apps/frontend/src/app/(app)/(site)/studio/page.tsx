import { redirect } from 'next/navigation';

// /studio has no page of its own - the sidebar flyout is the entry point.
export default async function Page() {
  redirect('/studio/clipping');
}
