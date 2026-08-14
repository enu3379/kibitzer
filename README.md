# Kibitzer

<div align="center">
  <img src="apps/extension/icons/icon-128.png" width="96" alt="Kibitzer 로고">
  <br>
  <br>
  <a href="https://chromewebstore.google.com/detail/kibitzer/lcjfjdokgphimdaoekjbecmcfjailall">
    <img src="https://img.shields.io/badge/Chrome_Web_Store-다운로드-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome Web Store에서 Kibitzer 다운로드">
  </a>
  <a href="https://www.instagram.com/kibitzer_app">
    <img src="https://img.shields.io/badge/Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white" alt="Kibitzer Instagram">
  </a>
  <a href="https://www.youtube.com/watch?v=WQm97Z4MQ90">
    <img src="https://img.shields.io/badge/YouTube-데모-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="Kibitzer YouTube 데모 영상">
  </a>
</div>

<br>

집중이 필요할 때 Kibitzer에게 목표 한 줄만 알려주세요. Kibitzer는 브라우징 흐름을 조용히 지켜보다 딴짓이 충분히 쌓였을 때 훈수 두는 Chrome 확장 프로그램입니다. 잠깐 다른 페이지를 열었다고 바로 잔소리하지 않습니다. 몰입 게이지가 차오르고 닳는 걸 지켜보다가 딴짓이 충분히 쌓였을 때만 화면 구석에서 슬쩍 한마디 건넵니다. 차단하지 않고, 오직 훈수만 둡니다. 목표한 세션이 종료되고 나면 세션 요약 통계 및 Kibitzer의 한줄평도 받을 수 있습니다.

사용자가 직접 API 키를 등록해 AI의 판정 및 훈수 사용을 선택할 수 있습니다. (Ollama Cloud · OpenRouter · Gemini · OpenAI · Claude · Deepseek · Kimi 지원)

## 실행

Node.js 22.6 이상과 Chrome 123 이상이 필요합니다. 로컬 언어 임베딩 모델은 첫 npm ci 때 내려받습니다.

```sh
cd apps/extension
npm ci
npm run build
```

`npm run build`는 모델 자산 확인, 테스트, 타입 검사, 번들 생성을 차례로 실행하여 빌드 후 `apps/extension/dist`에 Chrome에서 로드할 수 있는 확장 프로그램이 만들어집니다.

## 저장소 구조

```text
apps/extension/                         Chrome 확장 프로그램 전체
  src/                                  서비스 워커, 팝업, 설정, 판정 및 저장 로직
  assets/models/koen-e5-tiny/           로컬 임베딩 모델 및 토크나이저와 모델
  tools/replay.ts                       이벤트 로그를 다시 실행하는 CLI
  dist/                                 빌드 결과물

configs/
  personas.yaml                         페르소나 공통 설정
  personas/*.yaml                       페르소나별 말투 및 예시 문장
  sensitive_domains.json                판정에서 제외할 민감 도메인 목록

docs/                                   설계 문서, 결정 기록, 개인정보 처리방침
```

현재 프로그램의 구조 및 데이터 저장 방식은 [[docs/README.md]]에서 확인할 수 있습니다.

## 개인정보 및 데이터

- 이 확장프로그램은 아무런 정보도 수집하지 않습니다.
- 1차 판정은 함께 설치되는 한국어·영어 임베딩 모델이 브라우저 안에서 수행합니다.
- LLM API를 사용한 빠른 판정에는 목표·제목·호스트·최근 제목이, 정밀 판정에는 현재 페이지 본문 발췌(최대 3,000자)가 추가로 선택한 AI 서비스 제공자에게 전송됩니다. path와 query가 포함된 전체 주소는 보내지 않습니다.
- AI 사용은 설정에서 언제든 끌 수 있습니다.단 판정 품질이 낮아지고 훈수 문장은 준비된 문구로 단순해집니다.
- 관측에서 제외할 도메인 목록을 추가할 수 있으며, 은행 · 결제 · 의료 · 정부 · 웹메일 같은 민감한 사이트는 목록에 넣지 않아도 처음부터 관측하지 않습니다.
- 판정 기록과 세션 이력은 브라우저 안에만 남고, 설정의 데이터 탭에서 한 번에 지울 수 있습니다.
- 시크릿 창에서는 동작하지 않습니다.

보다 구체적인 사항은 [Kibitzer 개인정보 처리방침](docs/privacy-policy.ko.md)를 참고해주시기 바랍니다.

## 라이선스

이 제품은 Apache License 2.0으로 배포되는 언어 임베딩 모델 `dragonkue-KoEn-E5-Tiny/model_O4.onnx`를 포함합니다. 자세한 내용은 [THIRD_PARTY_NOTICES.md](docs/THIRD_PARTY_NOTICES.md)를 참고하세요.

Copyright © 2026 Kibitzer. All rights reserved.
