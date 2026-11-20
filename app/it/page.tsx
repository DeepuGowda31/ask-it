import type { Metadata } from 'next';
import ItDashboard from '@/components/ItDashboard';

export const metadata: Metadata = { title: 'IT Operations | ASK IT' };

export default async function ItPage({ searchParams }: { searchParams: Promise<{ session?: string }> }) {
  const { session } = await searchParams;
  return <ItDashboard initialCode={String(session ?? '').trim().toUpperCase()} />;
}
