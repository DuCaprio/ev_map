import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get('q');

  if (!query || query.trim().length < 2) {
    return NextResponse.json({ found: false, reason: 'query too short' });
  }

  const kakaoKey = process.env.KAKAO_REST_API_KEY;
  if (!kakaoKey) {
    return NextResponse.json({ found: false, reason: 'no kakao key' }, { status: 500 });
  }

  try {
    // 제주 지역을 포함하는 사각형 범위에서 장소를 검색합니다.
    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&rect=126.10,32.95,127.05,33.65&size=1`;

    const res = await fetch(url, {
      headers: { Authorization: `KakaoAK ${kakaoKey}` },
      signal: AbortSignal.timeout(5000),
    });

    const data = res.ok ? await res.json() : null;
    const doc = data?.documents?.[0];

    if (!doc) {
      const addrUrl = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(query)}&size=1`;
      const addrRes = await fetch(addrUrl, {
        headers: { Authorization: `KakaoAK ${kakaoKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!addrRes.ok) return NextResponse.json({ found: false, reason: 'kakao api error' }, { status: 502 });
      const addrData = await addrRes.json();
      const doc = addrData.documents?.[0];
      if (!doc && !res.ok) return NextResponse.json({ found: false, reason: 'kakao api error' }, { status: 502 });
      if (!doc) return NextResponse.json({ found: false });
      return NextResponse.json({
        found: true,
        lat: parseFloat(doc.y),
        lng: parseFloat(doc.x),
        placeName: doc.address_name,
      });
    }

    return NextResponse.json({
      found: true,
      lat: parseFloat(doc.y),
      lng: parseFloat(doc.x),
      placeName: doc.place_name,
    });
  } catch (error) {
    console.error('Geocode error:', error);
    return NextResponse.json({ found: false, reason: 'exception' }, { status: 502 });
  }
}
