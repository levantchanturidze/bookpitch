import { notFound } from 'next/navigation';
import { getPublicLocation } from '@/lib/public-booking';
import BookingWidget from './BookingWidget';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const loc = await getPublicLocation(slug);
  return { title: loc ? `Book at ${loc.locationName}` : 'Bookpitch' };
}

export default async function PublicBookingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const loc = await getPublicLocation(slug);
  if (!loc) notFound();
  return (
    <main
      id="main"
      className="mx-auto min-h-screen max-w-2xl bg-slate-50 px-4 py-8"
    >
      <header className="mb-6">
        <h1 className="text-xl font-extrabold tracking-tight text-slate-900">
          {loc.locationName}
        </h1>
        <p className="mt-1 text-xs text-slate-500">
          {loc.organizationName} · {loc.locationType}
        </p>
      </header>
      <BookingWidget location={loc} slug={slug} />
    </main>
  );
}
