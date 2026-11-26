/**
 * lib/evApi.ts
 * 공공데이터 포털 전기차 충전기 정보 API 공통 모듈
 * - URL / 파라미터 정의를 한 곳에서 관리
 * - 타입 정의 공유
 * - 원시 응답 파싱 및 에러 처리 공통화
 */

import { get } from 'node:https';

// ─── 타입 ────────────────────────────────────────────────────

export interface RawChargerItem {
  statId: string;
  chgerId: string;
  statNm: string;
  addr: string;
  lat: string;
  lng: string;
  chgerType: string;
  stat: string;
}

export interface ChargerPort {
  chgerId: string;
  type: string;
  stat: string;
}

export interface Station {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  district: string;
  chargers: ChargerPort[];
}

// ─── API 호출 ─────────────────────────────────────────────────

/**
 * 공공데이터 포털에서 제주(zcode=50) 충전기 전체 목록을 가져옵니다.
 * @returns 원시 응답 아이템 배열
 * @throws API 키 미설정 또는 응답 오류 시 Error 던짐
 */
export async function fetchRawChargers(): Promise<RawChargerItem[]> {
  return fetchChargerPages<RawChargerItem>('getChargerInfo');
}

export async function fetchRecentChargerStatuses(): Promise<Pick<RawChargerItem, 'statId' | 'chgerId' | 'stat'>[]> {
  return fetchChargerPages('getChargerStatus');
}

async function fetchChargerPages<T>(operation: 'getChargerInfo' | 'getChargerStatus'): Promise<T[]> {
  const apiKey = process.env.EV_API_KEY;
  if (!apiKey) {
    throw new Error('EV_API_KEY 환경변수가 설정되지 않았습니다.');
  }

  const url = new URL(`https://apis.data.go.kr/B552584/EvCharger/${operation}`);
  url.searchParams.set('serviceKey', apiKey);
  const pageSize = 500;
  url.searchParams.set('numOfRows', String(pageSize));
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('zcode', '50');
  if (operation === 'getChargerStatus') url.searchParams.set('period', '10');
  url.searchParams.set('dataType', 'JSON');

  const items: T[] = [];
  let totalCount = 0;
  for (let page = 1; page === 1 || items.length < totalCount; page++) {
    url.searchParams.set('pageNo', String(page));
    const body = await requestChargerPage(url).catch(() => requestChargerPage(url));
    if (body.trimStart().startsWith('<')) {
      throw new Error('공공데이터 포털 오류: XML 응답 반환됨 (키 오류 또는 일시적 장애)');
    }

    const data = JSON.parse(body);
    if (data.resultCode !== '00') throw new Error('공공데이터 포털이 오류 응답을 반환했습니다.');
    const pageItems = data.items?.item;
    if (page === 1) totalCount = Number(data.totalCount);
    if (!Number.isSafeInteger(totalCount) || totalCount < 0 ||
        (totalCount > 0 && (!Array.isArray(pageItems) || pageItems.length === 0))) {
      throw new Error('공공데이터 포털이 유효한 충전기 목록을 반환하지 않았습니다.');
    }
    if (Array.isArray(pageItems)) items.push(...pageItems);
  }
  return items;
}

function requestChargerPage(url: URL): Promise<string> {
  return new Promise((resolve, reject) => {
    // IPv4로 직접 연결해 공공데이터 게이트웨이 응답 지연을 피합니다.
    const request = get(url, { family: 4, signal: AbortSignal.timeout(8_000) }, async (response) => {
      try {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`공공데이터 포털 HTTP 오류: ${response.statusCode}`));
          return;
        }
        response.setEncoding('utf8');
        let body = '';
        for await (const chunk of response) body += chunk;
        resolve(body);
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

// ─── 파싱 헬퍼 ───────────────────────────────────────────────

/**
 * 원시 아이템 배열을 Station 단위로 그룹화합니다.
 * 위경도가 없는 항목은 자동으로 제외됩니다.
 */
export function groupItemsToStations(items: RawChargerItem[]): Station[] {
  const stationsMap = new Map<string, Station>();

  for (const c of items) {
    const lat = parseFloat(c.lat);
    const lng = parseFloat(c.lng);
    if (isNaN(lat) || isNaN(lng)) continue;

    if (!stationsMap.has(c.statId)) {
      const match = (c.addr || '').match(
        /제주특별자치도\s+(제주시|서귀포시)\s+([^\s]+)/
      );
      let district = match ? match[2] : '기타';
      if (/[일이삼]동/.test(district)) {
        district = district.replace(/[일이삼]동/, '동');
      }

      stationsMap.set(c.statId, {
        id: c.statId,
        name: c.statNm,
        address: c.addr,
        lat,
        lng,
        district,
        chargers: [],
      });
    }

    stationsMap.get(c.statId)!.chargers.push({
      chgerId: c.chgerId,
      type: c.chgerType,
      stat: c.stat,
    });
  }

  return Array.from(stationsMap.values());
}
