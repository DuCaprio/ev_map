import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { GET as geocode } from '@/app/api/geocode/route';
import { GET as nearby } from '@/app/api/nearby/route';
import { isFastCharger, type Charger } from '@/types/charger';

export const runtime = 'nodejs';

type Station = Charger & { distance: string };
type Location = { lat: number; lng: number };
type Search = { place: string | null; speed: 'any' | 'fast' | 'slow'; availableOnly: boolean };
type ModelOutput = {
  type: string;
  name?: string;
  arguments?: string;
  content?: { type: string; text?: string; refusal?: string }[];
};

const RADIUS_KM = 3;
const MAX_AGE_MS = 15 * 60_000;
const REQUESTS_PER_MINUTE = 6;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const DEFAULT_DAILY_LIMIT = 100;
let minuteWindow = { start: 0, count: 0 };
let dayWindow = { start: 0, count: 0 };
const UNKNOWN_STATUS = '현재 충전기 상태를 확인할 수 없습니다. 잠시 후 다시 조회해 주세요.';
const lookupTool = {
  type: 'function',
  name: 'find_chargers',
  description: '제주에서 실제 충전소를 찾거나 가용 상태를 묻는 모든 요청을 조회합니다.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      place: { type: ['string', 'null'], description: '제주 장소 이름. 사용자 현재 위치면 null.' },
      speed: { type: 'string', enum: ['any', 'fast', 'slow'] },
      availableOnly: { type: 'boolean', description: '지금 사용 가능하거나 빈 충전기를 요청하면 true.' },
    },
    required: ['place', 'speed', 'availableOnly'],
    additionalProperties: false,
  },
};

function parseLocation(value: unknown): Location | undefined {
  if (!value || typeof value !== 'object' || !('lat' in value) || !('lng' in value)) return;
  const { lat, lng } = value;
  if (typeof lat === 'number' && typeof lng === 'number' &&
      Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng };
  }
}

function getHistory(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(-6).flatMap(turn => {
    const text = turn?.parts?.[0]?.text;
    if (typeof text !== 'string' || !['user', 'model'].includes(turn?.role)) return [];
    return [{ role: turn.role === 'model' ? 'assistant' : 'user', content: text.slice(0, 500) }];
  });
}

function reserveRequest() {
  const now = Date.now();
  const currentDay = Math.floor(now / DAY_MS) * DAY_MS;
  if (dayWindow.start !== currentDay) dayWindow = { start: currentDay, count: 0 };
  if (now - minuteWindow.start >= MINUTE_MS) minuteWindow = { start: now, count: 0 };
  const configured = Number(process.env.OPENAI_DAILY_REQUEST_LIMIT ?? DEFAULT_DAILY_LIMIT);
  const dailyLimit = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_DAILY_LIMIT;
  const blockedUntil = Math.max(
    dayWindow.count >= dailyLimit ? dayWindow.start + DAY_MS : 0,
    minuteWindow.count >= REQUESTS_PER_MINUTE ? minuteWindow.start + MINUTE_MS : 0,
  );
  if (blockedUntil > now) return Math.ceil((blockedUntil - now) / 1000);

  dayWindow.count++;
  minuteWindow.count++;
  return 0;
}

async function answerWithStations(req: Request, search: Search, location?: Location) {
  let label = '현재 위치';
  if (search.place) {
    const url = new URL('/api/geocode', req.url);
    url.searchParams.set('q', search.place);
    const response = await geocode(new Request(url));
    const place = await response.json();
    if (!response.ok) return NextResponse.json({ reply: '장소 검색에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
    if (!place.found) return NextResponse.json({ reply: '제주에서 해당 장소를 찾지 못했습니다. 장소명이나 주소를 확인해 주세요.' });
    location = parseLocation(place);
    label = place.placeName;
    if (!location) return NextResponse.json({ reply: '장소 좌표를 확인할 수 없습니다.' });
  }
  if (!location) return NextResponse.json({ reply: '어느 곳 주변을 찾을까요? 장소명을 입력하거나 내 위치 버튼을 눌러 주세요.' });

  const url = new URL('/api/nearby', req.url);
  url.search = new URLSearchParams({
    lat: String(location.lat), lng: String(location.lng), radius: String(RADIUS_KM), limit: '10000',
  }).toString();
  const response = await nearby(new Request(url));
  if (!response.ok) return NextResponse.json({ reply: '충전소 목록을 조회하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  const { stations } = await response.json() as { stations: Station[] };

  const candidates = stations.flatMap(station => {
    const ports = station.chargers.filter(port => search.speed === 'any' ||
      (search.speed === 'fast' ? isFastCharger(port.type) : port.type === '02'));
    return ports.length ? [{ station, ports }] : [];
  });
  const speed = search.speed === 'fast' ? '급속 ' : search.speed === 'slow' ? '완속 ' : '';
  if (!candidates.length) return NextResponse.json({ reply: `${label} 반경 ${RADIUS_KM}km의 지도 목록에서 ${speed}충전소를 찾지 못했습니다.` });

  const dbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const dbKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!dbUrl || !dbKey) return NextResponse.json({ reply: UNKNOWN_STATUS });
  const db = createClient(dbUrl, dbKey);
  const statuses = new Map<string, { stat: string; updated_at: string }>();
  const portIds = candidates.flatMap(({ station, ports }) => ports.map(port => `${station.id}_${port.chgerId}`));
  for (let offset = 0; offset < portIds.length; offset += 100) {
    const { data, error } = await db.from('charger_status')
      .select('id, stat, updated_at').in('id', portIds.slice(offset, offset + 100))
      .abortSignal(AbortSignal.timeout(5000));
    if (error) return NextResponse.json({ reply: UNKNOWN_STATUS });
    for (const row of data) statuses.set(row.id, row);
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  const results = candidates.map(({ station, ports }) => {
    const recent = ports.flatMap(port => {
      const row = statuses.get(`${station.id}_${port.chgerId}`);
      const checkedAt = Date.parse(row?.updated_at ?? '');
      return row && checkedAt >= cutoff && ['2', '3', '4', '5'].includes(row.stat) ? [{ ...row, checkedAt }] : [];
    });
    return {
      station, available: recent.filter(row => row.stat === '2').length,
      checked: recent.length, total: ports.length,
      oldestCheck: Math.min(...recent.map(row => row.checkedAt)),
    };
  });

  if (!results.some(result => result.checked > 0)) {
    return NextResponse.json({ reply: `${label} 주변의 ${speed}충전소는 찾았지만 ${UNKNOWN_STATUS}` });
  }
  const eligible = results.filter(result => !search.availableOnly || result.available > 0);
  if (!eligible.length) {
    const hasUnknown = results.some(result => result.checked < result.total);
    return NextResponse.json({
      reply: `${label} 반경 ${RADIUS_KM}km에서 사용 가능으로 확인된 ${speed}충전기가 없습니다.${hasUnknown ? ' 일부 충전기는 현재 상태를 확인할 수 없습니다.' : ''}`,
    });
  }

  const displayed = eligible.slice(0, 5);
  const clock = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const lines = displayed.map(({ station, available, checked, total, oldestCheck }, index) =>
    checked === 0
      ? `${index + 1}. **${station.name}** · 직선 ${station.distance}km · 상태 미확인`
      : `${index + 1}. **${station.name}** · 직선 ${station.distance}km · ${speed}사용 가능 ${available}대 · ${clock.format(oldestCheck)} 이후 확인${total > checked ? ` · 미확인 ${total - checked}대` : ''}`,
  );
  return NextResponse.json({
    reply: `${label} 반경 ${RADIUS_KM}km의 ${speed}충전소입니다. 확인 시각은 한국 시간입니다.\n\n${lines.join('\n')}`,
    stations: displayed.map(({ station }) => ({
      ...station,
      chargers: station.chargers.map(({ chgerId, type }) => ({ chgerId, type })),
    })),
    stationLabel: `${label} 근처 ${speed}충전소`,
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (typeof body?.message !== 'string' || !body.message.trim() || body.message.length > 2000) {
    return NextResponse.json({ error: '질문을 1~2,000자로 입력해 주세요.' }, { status: 400 });
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ error: '서버에 OpenAI API 키가 설정되지 않았습니다.' }, { status: 503 });

  const retryAfter = reserveRequest();
  if (retryAfter) {
    return NextResponse.json(
      { error: '앱의 AI 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }

  const location = parseLocation(body.location);
  const model = process.env.OPENAI_MODEL?.trim() || 'gpt-6-luna';
  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({
        model,
        ...(model === 'gpt-6-luna' ? { reasoning: { effort: 'none' } } : {}),
        store: false,
        instructions: `제주 전기차 충전 도우미로 한국어로 간단히 답합니다.
장소나 현재 위치 주변 충전소, 사용 가능 여부, 거리, 대수를 물으면 반드시 find_chargers를 호출합니다.
앞 문맥의 장소와 조건을 이어받되 사용자가 바꾼 조건을 우선합니다.
명시된 장소가 없으면 place를 null로 호출합니다. GPS 사용 여부: ${location ? '있음' : '없음'}.
실제로 조회하지 않은 충전소 상태, 대수, 현재 요금은 추측하지 않습니다. 일반 충전 지식 질문에는 직접 답합니다.`,
        input: [...getHistory(body.history), { role: 'user', content: body.message.trim() }],
        tools: [lookupTool],
        parallel_tool_calls: false,
        max_output_tokens: 320,
      }),
    });
    if (!response.ok) {
      console.error('OpenAI responses HTTP status:', response.status);
      return NextResponse.json({
        error: response.status === 429 ? 'AI 서비스 요청 한도 또는 사용량 설정을 확인해 주세요.' : 'AI 서비스 연결에 실패했습니다.',
      }, { status: response.status === 429 ? 429 : 502 });
    }
    const data = await response.json() as { output?: ModelOutput[] };
    const call = data.output?.find(item => item.type === 'function_call' && item.name === lookupTool.name);
    if (call?.arguments) {
      const search = JSON.parse(call.arguments) as Search;
      if ((search.place === null || (typeof search.place === 'string' && search.place.length <= 120)) &&
          ['any', 'fast', 'slow'].includes(search.speed) && typeof search.availableOnly === 'boolean') {
        return await answerWithStations(req, search, location);
      }
      throw new Error('Invalid search arguments');
    }

    const reply = data.output?.flatMap(item => item.content ?? [])
      .map(item => item.text ?? item.refusal ?? '').join('\n').trim();
    if (!reply) throw new Error('Empty model response');
    return NextResponse.json({ reply });
  } catch (error) {
    console.error('Chat request failed:', error instanceof Error ? error.name : 'UnknownError');
    return NextResponse.json({ error: '답변을 처리하는 중 문제가 발생했습니다. 잠시 후 다시 시도해 주세요.' }, { status: 502 });
  }
}
