import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// ===================== 환경 변수 =====================
const TARGET_URL   = (__ENV.TARGET_URL || '').replace(/\/+$/, '');
const ACCESS_TOKEN = __ENV.ACCESS_TOKEN || '';

// ===================== 고정값 =====================
const CATEGORY = '-1';   // ← 서버 요구사항: category
const PAGE     = '0';
const SIZE     = '100';
const MOBILE_TYPE = 'ANDROID';

// ===================== 커스텀 메트릭 =====================
export const latencyBacklogs = new Trend('latency_backlogs_ms', true);
export const ttfbBacklogs    = new Trend('ttfb_backlogs_ms', true);
export const http4xxRate     = new Rate('http_4xx_rate');
export const http5xxRate     = new Rate('http_5xx_rate');
export const failures        = new Counter('checks_failed');

// ===================== 옵션 (Load / 약한 Stress 겸용) =====================
export const options = {
  thresholds: {
    http_req_failed: ['rate==0'],       // 전체 실패율 0%
    http_4xx_rate:   ['rate==0'],       // 4xx 없음
    http_5xx_rate:   ['rate==0'],       // 5xx 없음
    latency_backlogs_ms: ['p(95)<100'], // 목표 구간 p95 < 100ms (깨지는 지점 확인용)
  },
  scenarios: {
    backlogs_load: {
      executor: 'ramping-arrival-rate',
      exec: 'backlogsScenario',
      startRate: 20,          // 시작 RPS
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 500,
      stages: [
        { target: 30, duration: '2m' },
        { target: 40, duration: '2m' },
        { target: 50, duration: '2m' },
        { target: 60, duration: '2m' },
        { target: 70, duration: '2m' },
        { target: 80, duration: '2m' },
        { target: 90, duration: '2m' },
        // 램프다운
        { target: 0,  duration: '2m' },
      ],
      tags: { scenario: 'backlogs_load' },
    },
  },
  tags: {
    service: 'todo-service',
    endpoint: '/backlogs',
    test_type: 'load',
  },
};

// ===================== 유틸 함수 =====================
function buildHeaders() {
  const token = ACCESS_TOKEN.trim();
  const auth = token.toLowerCase().startsWith('bearer ')
    ? token
    : `Bearer ${token}`;

  return {
    Authorization: auth,
    'X-Mobile-Type': MOBILE_TYPE,
    Accept: 'application/json',
  };
}

function buildUrl() {
  // ⚠️ 실제 API는 category= 으로 전달해야 함!
  return (
    `${TARGET_URL}/backlogs` +
    `?category=${CATEGORY}` +
    `&page=${PAGE}` +
    `&size=${SIZE}`
  );
}

function recordMetrics(res) {
  latencyBacklogs.add(res.timings.duration);
  ttfbBacklogs.add(res.timings.waiting);

  http5xxRate.add(res.status >= 500);
  http4xxRate.add(res.status >= 400 && res.status < 500);

  const ok = check(res, {
    'status is 2xx/3xx': (r) => r.status >= 200 && r.status < 400,
  });

  if (!ok) failures.add(1);
}

// ===================== /backlogs 호출 =====================
function callBacklogs() {
  const res = http.get(buildUrl(), {
    headers: buildHeaders(),
    tags: { endpoint: '/backlogs' },
  });

  recordMetrics(res);
  return res;
}

// ===================== 시나리오 엔트리 =====================
export function backlogsScenario() {
  callBacklogs();
  // arrival-rate라 sleep은 RPS에 큰 영향 없지만,
  // 사용자 think-time 느낌을 위해 0.3~0.6초 정도만 줌
  sleep(0.3 + Math.random() * 0.3);
}

// ===================== Summary =====================
export function handleSummary(data) {
  const totalReqs = data.metrics.http_reqs?.values?.count || 0;
  const durationS = (data.state.testRunDurationMs || 0) / 1000 || 1;
  const rps       = totalReqs / durationS;

  const p95Back = data.metrics.latency_backlogs_ms?.values['p(95)'] || 0;
  const p95Ttfb = data.metrics.ttfb_backlogs_ms?.values['p(95)'] || 0;

  const txt = [
    '=== /backlogs Load(+Stress) Test Summary ===',
    `Target URL       : ${TARGET_URL}`,
    `Query Params     : category=${CATEGORY}, page=${PAGE}, size=${SIZE}`,
    `Total Requests   : ${totalReqs}`,
    `Avg RPS          : ${rps.toFixed(1)}`,
    '',
    `latency_backlogs_ms p95 : ${p95Back.toFixed(1)} ms`,
    `ttfb_backlogs_ms   p95  : ${p95Ttfb.toFixed(1)} ms`,
  ].join('\n');

  return {
    stdout: txt,
    'backlogs-load-result.json': JSON.stringify(data, null, 2),
  };
}
