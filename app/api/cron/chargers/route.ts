import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { fetchRawChargers, fetchRecentChargerStatuses } from '@/lib/evApi';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function GET(req: Request) {
  // ── 보안: CRON_SECRET 미설정 시 항상 차단 ──────────────────
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[Cron] CRON_SECRET 환경변수가 설정되지 않았습니다. 요청 차단.');
    return new NextResponse('Unauthorized', { status: 401 });
  }
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${secret}`) {
    return new NextResponse('Unauthorized', { status: 401 });
  }

  try {
    // ── 현재 DB 상태 로드 (페이지네이션) ─────────────────────
    const existingMap: Record<string, string> = {};
    let start = 0;
    const PAGE = 1000;

    while (true) {
      const { data: existing, error } = await supabase
        .from('charger_status')
        .select('id, stat')
        .order('id')
        .range(start, start + PAGE - 1);

      if (error) throw error;
      if (!existing || existing.length === 0) break;

      for (const row of existing) {
        existingMap[row.id] = row.stat;
      }

      if (existing.length < PAGE) break;
      start += PAGE;
    }

    const fullSync = new URL(req.url).searchParams.get('full') === '1';
    const items = fullSync ? await fetchRawChargers() : await fetchRecentChargerStatuses();

    // The timestamp records when the provider last confirmed each port.
    const checkedAt = new Date().toISOString();
    const rows = [...new Map(items.map(charger => {
      const id = `${charger.statId}_${charger.chgerId}`;
      return [id, {
        id,
        stat_id: charger.statId,
        chger_id: charger.chgerId,
        stat: charger.stat,
        updated_at: checkedAt,
      }];
    })).values()];
    const updatedCount = rows.filter(row => existingMap[row.id] !== row.stat).length;

    const batchSize = 500;
    for (let start = 0; start < rows.length; start += batchSize) {
      const { error } = await supabase
        .from('charger_status')
        .upsert(rows.slice(start, start + batchSize), { onConflict: 'id' });
      if (error) throw error;
    }

    return NextResponse.json({ success: true, fullSync, updatedCount, checkedCount: rows.length });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[Cron] 에러:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
