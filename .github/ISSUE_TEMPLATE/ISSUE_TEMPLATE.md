---
name: "Issue 생성 템플릿"
about: 해당 Issue 생성 템플릿을 통하여 Issue를 생성해주세요.
title: 'ex) [load] : Issue 제목'
labels: ''
assignees: ''

---

## 🎯 테스트 목표
<br>

### 📝 Description
#### 📈 테스트 시나리오
테스트 종류: Stress Test (Stress, Load, Spike 등)

시나리오 설명:

최대 가상 사용자(VUs): 1000

테스트 총 시간(Duration): 10분

#### ✅ 성공 기준 (Success Criteria)
평균 응답 시간 (avg_response_time): 200ms 미만

p95 응답 시간 (p95_response_time): 500ms 미만

에러율 (error_rate): 1% 미만


## 🔬 테스트 대상 API
- **Method**: `POST`
- **Endpoint**: `/auth/login`
- **Request Body (예시)**:
  ```json
  {
    "username": "testuser",
    "password": "password123"
  }

