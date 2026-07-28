// Hand-authored preview copy for the persona picker (설정 › 말투).
//
// Deliberately NOT part of personas.data.ts: that file is generated from
// configs/personas/*.yaml by scripts/gen-personas.py and must not be edited by hand.
// These strings are UI chrome — they never reach a provider prompt — so they live here
// instead of round-tripping through the YAML → generator pipeline.
//
// Both lines are fully written out rather than templated. The picker has no live session
// to draw a goal or host from, and a literal string sidesteps the particle agreement that
// fillTemplate() exists to handle. The implied context matches the onboarding wizard's
// SAMPLE_CTX so the two screens read as the same demo: goal "논문 정리", host youtube.com.
//
// Each line is checked against its persona's own voice rules in configs/personas/*.yaml
// (sentence endings, honorific level, banned vocabulary).

export interface PersonaSampleLines {
  /** Shown while hovering or focusing a persona — the most recognizable nag of that voice. */
  hover: string
  /** Shown once the persona is selected — that voice accepting the job. */
  picked: string
}

/** Keyed by the persona keys in PERSONA_ORDER (personas.data.ts). */
export const PERSONA_SAMPLE_LINES: Record<string, PersonaSampleLines> = {
  dry_kibitzer: {
    hover: "대단히 생산적인 방문이군요. 논문 정리만 빼고 전부 진행 중입니다.",
    picked: "잘 부탁드립니다. 자리는 어깨너머로만 지키겠습니다.",
  },
  chungcheong: {
    hover: "이 속도면 논문 정리는 다음 계절에나 뵙겠어요.",
    picked: "알겠어요, 지나가다 슬쩍 한마디씩만 거들어 볼게요.",
  },
  kyoto: {
    hover: "장바구니 채우는 눈썰미, 논문 정리에도 조금만 나눠 주시면 좋을 텐데요.",
    picked: "좋은 목표시네요, 흔들리시면 제가 살짝 알려드릴게요.",
  },
  quiet_coach: {
    hover: "벤치로 잠깐 빠지셨네요. 첫 문장 하나만 써볼까요?",
    picked: "좋습니다, 오늘부터 코치 맡죠. 흔들려도 끝까지 갑니다.",
  },
  tsundere: {
    hover: "그거 목표랑 상관없지 않아? 보고 있기 답답해서 하는 말이야.",
    picked: "뭐, 알겠어. 딱히 챙겨주려는 거 아니고 그냥 맡은 거야.",
  },
  yandere: {
    hover: "지금 화면에 뜬 걔, 유튜브… 누구야? 나는 처음 보는 애인데.",
    picked: "좋아, 이제부터 계속 지켜볼게…… 다 세고 있을 거야.",
  },
  navigation: {
    hover: "금일 3번째 이탈입니다. 목적지 '논문 정리'까지의 경로를 재탐색합니다.",
    picked: "안내를 시작합니다. 목적지는 '논문 정리'입니다.",
  },
  documentary: {
    hover: "목표를 향하던 개체가 방향을 틀어 사냥터로 진입했다.",
    picked: "오늘부터 이 개체의 이동을 관찰한다. 목적지는 논문 정리다.",
  },
  game_caster: {
    hover: "논문 정리 흐름이 갑자기 끊겨 기분이 좀 나쁘죠?",
    picked: "자, 오늘 경기 시작합니다. 논문 정리 향한 이 판단, 끝까지 지켜보죠.",
  },
  baseball_caster: {
    hover: "초구부터 크게 빠집니다. 공은 유튜브 관중석 쪽으로 향했습니다.",
    picked: "자, 스트라이크 존 들어갑니다. 목표는 논문 정리, 오늘부터 봐드리죠.",
  },
}

export const sampleLinesFor = (key: string): PersonaSampleLines | undefined =>
  PERSONA_SAMPLE_LINES[key]
