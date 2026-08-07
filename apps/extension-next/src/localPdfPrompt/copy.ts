/** User-facing copy for the one-time local-PDF opt-in prompt.
 *  Keep every editable sentence here so copy changes do not touch behavior/layout. */
export const LOCAL_PDF_PROMPT_COPY = {
  eyebrow: "로컬 PDF를 열었어요",
  question: "이 PDF의 제목도 흐름 판단에 사용할까요?",
  disclosure:
    "Chrome 탭에 표시되는 제목(파일명 또는 문서 제목)만 판정에 사용하며, 이 제목은 연결한 AI 제공자에게 전송될 수 있습니다. 파일 경로와 PDF 본문은 읽거나 전송하지 않아요.",
  decline: "지금은 안 함",
  enable: "제목 관측 켜기",
  enabling: "설정을 켜는 중…",
  enabled: "제목 관측이 켜졌습니다.",
  partialError:
    "제목 관측은 켜졌지만 PDF 탭으로 돌아가지 못했습니다. 이 창을 닫고 PDF 탭을 다시 선택해 주세요.",
  error: "설정을 바꾸지 못했습니다. Kibitzer 설정에서 다시 시도해 주세요.",
} as const
