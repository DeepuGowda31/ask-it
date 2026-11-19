import { NextRequest, NextResponse } from 'next/server';
import { getStore } from '@/lib/server/store';
import { createSession } from '@/lib/server/session';
import { buildDeps, seedOptions } from '@/lib/server/deps';
import { findAsset, type Asset } from '@/lib/domain/assets';
import { createSessionState } from '@/lib/domain/seed';
import type { AssetVisit } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';

const reply = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

// A scanned device with its open ticket, if ServiceNow answers; the call checks again before raising one.
async function visit(asset: Asset, now: number): Promise<AssetVisit> {
  const seed = seedOptions();
  const found = await buildDeps(createSessionState('', now, seed), now).tickets.findOpenForAsset(asset.id);
  return { id: asset.id, ticket: found.ok ? found.value : null };
}

// Starts a fresh demo session: a short room code with its own copy of the seed data, optionally for a scanned device.
export async function POST(request?: NextRequest) {
  let body: { asset?: unknown } = {};
  try {
    const text = request ? await request.text() : '';
    if (text) body = JSON.parse(text) ?? {};
  } catch {
    return reply({ error: 'Invalid JSON body' }, 400);
  }
  const asset = body.asset === undefined ? null : findAsset(body.asset);
  if (asset === undefined) return reply({ error: 'unknown_asset' }, 400);
  try {
    const now = Date.now();
    const code = await createSession(getStore(), now, seedOptions(), asset ? await visit(asset, now) : null);
    return reply({ code }, 201);
  } catch (error) {
    console.error('Failed to create session:', error);
    return reply({ error: 'Could not create a session. Check the state store configuration.' }, 500);
  }
}
