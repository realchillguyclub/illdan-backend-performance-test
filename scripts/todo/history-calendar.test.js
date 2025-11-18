import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// ===================== 환경 변수 =====================
const TARGET_URL    = __ENV.TARGET_URL;
const ACCESS_TOKEN  = __ENV.ACCESS_TOKEN; // "Bearer ..." 미포함 시 자동으로 붙여줌
const APP_VERSION = 'V2';         // V1(레거시) | V2(신규)
const YEAR        = '2025';
const MONTH       = '10';
const MONTH_LIST  = (__ENV.MONTH_LIST || '').trim();

// ===================== 커스텀 메트릭 =====================
export const http5xxRate = new Rate('http_5xx_rate');
export const http4xxRate = new Rate('http_4xx_rate');
export const latencyMs   = new Trend('latency_ms');
export const bodyBytes   = new Trend('body_bytes');
export const failures    = new Counter('checks_failed');

// ===================== 옵션/시나리오 =====================
export const options = {
  thresholds: {
    http_req_failed: ['rate<0.01'],     // 전체 실패 < 1%
    http_5xx_rate:  ['rate==0'],        // 5xx = 0
    http_4xx_rate:  ['rate<0.005'],     // 4xx < 0.5%
    latency_ms:     ['p(95)<300'],      // p95 < 300ms
  },
  scenarios: {
    // 1) 스모크(빠른 점검)
    smoke: {
      executor: 'constant-arrival-rate',
      exec: 'scenarioOnce',
      rate: 2,               // RPS
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 5,
      tags: { scenario: 'smoke' },
    },
    // 2) 부하(RPS 고정)
    load: {
      executor: 'ramping-arrival-rate',
      exec: 'scenarioOnce',
      startRate: 5,
      timeUnit: '1s',
      preAllocatedVUs: 20,
      maxVUs: 50,
      stages: [
        { target: 20, duration: '1m' }, // 20 rps까지 램프업
        { target: 20, duration: '2m' }, // 유지
        { target: 0,  duration: '30s' } // 램프다운
      ],
      tags: { scenario: 'load' },
      startTime: '40s',
    },
    // 3) 스트레스(점증 RPS)
    stress: {
      executor: 'ramping-arrival-rate',
      exec: 'scenarioOnce',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 30,
      maxVUs: 120,
      stages: [
        { target: 30, duration: '45s' },
        { target: 60, duration: '45s' },
        { target: 90, duration: '45s' },
        { target:  0, duration: '30s' },
      ],
      tags: { scenario: 'stress' },
      startTime: '3m',
    },
    // 4) 월별 스윕(옵션)
    month_sweep: {
      executor: 'per-vu-iterations',
      exec: 'scenarioMonthSweep',
      vus: 1,
      iterations: 1,
      startTime: '5m',
      tags: { scenario: 'month_sweep' },
      // MONTH_LIST가 비어있으면 내부에서 현재 MONTH 1회만 수행
    },
  },
  // 결과를 Influx에서 태그/필터링 쉽게
  tags: { service: 'calendar', endpoint: '/calendar', appVersion: APP_VERSION },
};

// ===================== 유틸 =====================
function authHeader() {
  const t = ACCESS_TOKEN.trim();
  return t.toLowerCase().startsWith('bearer ') ? t : `Bearer ${t}`;
}
function enc(v) {
  // URLSearchParams가 없으므로 직접 인코딩
  try { return encodeURIComponent(String(v)); } catch (e) { return String(v); }
}
function buildUrl(year, month) {
  const target = TARGET_URL.replace(/\/+$/, '');
  return `${target}/calendar?year=${enc(year)}&month=${enc(month)}`;
}
function headers() {
  return {
    Authorization: authHeader(),
    'X-App-Version': APP_VERSION,  // 서버 defaultValue=V1 이지만 명시 전달
    Accept: 'application/json',
  };
}
function safeJson(res) { try { return res.json(); } catch { return null; } }

// 공통 호출 + 체크
function callCalendar(year, month) {
  const url = buildUrl(year, month);
  const res = http.get(url, { headers: headers(), tags: { endpoint: '/calendar', appVersion: APP_VERSION } });

  latencyMs.add(res.timings.duration);
  bodyBytes.add((res.body && res.body.length) || 0);
  http5xxRate.add(res.status >= 500);
  http4xxRate.add(res.status >= 400 && res.status < 500);

  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'json parsable': (r) => { try { r.json(); return true; } catch { return false; } },
  });

  if (!ok) failures.add(1);

  const body = safeJson(res);
  if (body) {
    const baseOk = check(body, {
      'api wrapper shape': (b) => typeof b.isSuccess === 'boolean' && 'code' in b && 'message' in b && 'result' in b,
    });
    if (!baseOk) failures.add(1);

    if (APP_VERSION === 'V1') {
      // 레거시: dates 배열 혹은 result 자체가 배열일 수 있음(서버 구현에 맞게 수정)
      const legacyOk = Array.isArray(body.result) || (body.result && Array.isArray(body.result.dates));
      if (!legacyOk) failures.add(1);
    } else {
      // V2: result.dates 존재 가정
      const v2Ok = body.result && Array.isArray(body.result.dates);
      if (!v2Ok) failures.add(1);
    }
  }

  // k6 응답 객체에 직접 태그를 다시 설정할 수는 없으므로 생략

  sleep(Math.random() * 0.5 + 0.1);
  return res;
}

// ===================== 시나리오 엔트리 =====================
export function scenarioOnce() {
  callCalendar(YEAR, MONTH);
}

export function scenarioMonthSweep() {
  const months = MONTH_LIST ? MONTH_LIST.split(',').map((m) => m.trim()).filter(Boolean) : [MONTH];
  for (const m of months) callCalendar(YEAR, m);
}

// ===================== 요약 =====================
export function handleSummary(data) {
  const p95 = data.metrics['http_req_duration']?.values?.p(95) ?? 0;
  const reqs = data.metrics['http_reqs']?.values?.count ?? 0;
  const fail = data.metrics['http_req_failed']?.values?.rate ?? 0;
  const _5xx = data.metrics['http_5xx_rate']?.values?.rate ?? 0;
  const _4xx = data.metrics['http_4xx_rate']?.values?.rate ?? 0;

  const txt = [
    '=== /calendar k6 Summary ===',
    `Target URL    : ${TARGET_URL}`,
    `App Version : ${APP_VERSION}`,
    `Year/Month  : ${YEAR}/${MONTH}${MONTH_LIST ? ` [LIST=${MONTH_LIST}]` : ''}`,
    `Requests    : ${reqs}`,
    `Fail Rate   : ${(fail * 100).toFixed(2)}%`,
    `4xx Rate    : ${(_4xx * 100).toFixed(3)}%`,
    `5xx Rate    : ${(_5xx * 100).toFixed(3)}%`,
    `p95 Latency : ${p95.toFixed(1)} ms`,
    '',
  ].join('\n');

  return {
    stdout: txt,
    'history-calendar-summary.json': JSON.stringify(data, null, 2),
  };
}