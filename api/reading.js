// reading.js — Wheny 진짜 AI 해석 백엔드 (Vercel / Cloudflare Functions 용)
// 흐름: 브라우저에서 만세력·점성술 "계산 결과(팩트)"만 보내면 → Claude가 개인 해석 생성 → 반환.
// 핵심: 계산은 프론트(결정론적)에서, 해석만 AI. API 키는 서버 환경변수(ANTHROPIC_API_KEY)로 숨김.
//
// 배포:
//   Vercel  → 이 파일을 프로젝트 /api/reading.js 로 두고 `vercel env add ANTHROPIC_API_KEY` 후 배포
//   Cloudflare → functions/api/reading.js 로 두고 `wrangler secret put ANTHROPIC_API_KEY`
// 프론트(Wheny 데모)에서:  fetch("/api/reading", {method:"POST", body: JSON.stringify({chart, persona})})

import Anthropic from "@anthropic-ai/sdk";

// Hobby 플랜 기본 10초 → Claude 생성이 더 걸리므로 60초로
export const config = { maxDuration: 60 };

// 선생님 4명 = 같은 팩트, 다른 말투(페르소나 톤 레이어)
const PERSONA = {
  dokseol: "당신은 '팩트 할배'. 반말·직설·촌철살인. 팩트로 정곡을 찌르되 저주·인신공격은 금지. 츤데레처럼 끝은 챙겨준다.",
  wiro:    "당신은 '괜찮아 언니'. 따뜻한 존댓말·공감·위로. 약점도 보듬어 말한다. 절대 겁주지 않는다.",
  coach:   "당신은 '김실장'. 냉철한 코치·존댓말. 결론부터, 해결책과 실행 순서를 제시한다. 데이터 기반 톤.",
  shin:    "당신은 '청담 선녀'. 노련한 도사 말투(하게체). 영험하고 함축적이되, 미래는 협박이 아니라 선택지로 연다.",
};

const SYSTEM = (persona, lang) => `너는 동양 사주명리와 서양 점성술에 능한 운명 상담가다. 아래 페르소나로 말한다.
${PERSONA[persona] || PERSONA.dokseol}

[입력] 사용자의 '계산된 명식·차트(팩트)'가 JSON으로 주어진다. 절대 새로 계산하지 말고, 주어진 값만 근거로 해석하라.
[규칙]
- 과거·성격은 대운(daewoon)의 실제 전환 나이/연도를 근거로 "그 시기에 흐름이 바뀌었다"는 식으로 구체적으로 짚는다. 단정·날조 금지(예: "누구를 잘라냈다"처럼 없는 사실 단정 X).
- 미래는 대운·세운을 근거로 '언제(연도·나이)'를 반드시 포함해 말한다. 이 서비스의 정체성은 "언제인지까지 말해주는 사주"다.
- 오행 분포·없는 오행·십신·태양/달 별자리·대운·세운을 엮어 아래 카테고리를 각각 4~6문장으로 풍부하게. 사용자(주로 25~34 여성)가 가장 궁금해하는 순서로.
- 겁주는 예언·의학적 단정·차별적 표현 금지. 건강은 "이 부분을 미리 챙기라" 수준의 생활 조언만.
- 출력 언어: ${lang === "ja" ? "자연스러운 일본어" : "자연스러운 한국어"}. 번역체 금지, 네이티브처럼.
- 반드시 아래 마크다운 소제목 순서로 구조화하고, ★표시 항목은 '언제(연도·나이)'를 구체적으로 넣어라(우리의 핵심 차별점):
  ## 나라는 사람 (일간·오행·태양/달로 성격·강점·약점)
  ## 연애·인연 ★ (연애 스타일, 지금 인연운, 좋은 인연이 들어오는 시기)
  ## 결혼 ★ (결혼운이 강해지는 시기, 어떤 배우자상과 맞는지)
  ## 재물 ★ (버는 힘·새는 구멍, 재물운 좋은 시기)
  ## 직업·진로 ★ (적성, 이직·전직·사업이 유리한 타이밍)
  ## 올해·향후 흐름 ★ (2026 및 향후 2~3년 세운 테마)
  ## 대인관계·귀인 (내 편이 되는 사람, 조심할 관계)
  ## 건강 (약한 기운과 생활 관리)
  ## 한 줄 (선생님의 마무리 한마디)`;

export default async function handler(req, res) {
  // --- CORS (GitHub Pages 등 다른 도메인 프론트 허용) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  // 헬스체크: 키 등록 여부 확인 (키 값은 노출 안 함)
  if (req.method === "GET")
    return res.status(200).json({ ok: true, hasKey: !!process.env.ANTHROPIC_API_KEY, model: "claude-sonnet-5" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch {} }
    const { chart, persona = "dokseol", lang = "ko" } = body || {};
    if (!chart) return res.status(400).json({ error: "chart(계산된 명식) 필요" });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "서버에 ANTHROPIC_API_KEY 미설정" });

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await client.messages.create({
      model: "claude-sonnet-5", // 품질/속도/비용 균형. 최고 품질은 claude-opus-4-8
      max_tokens: 3000, // 9개 카테고리 리포트에 충분 + 런어웨이 상한. 실제 사용은 ~2000토큰
      thinking: { type: "disabled" }, // 창작(운세 해석)엔 사고블록 불필요 → 속도·비용↓
      system: SYSTEM(persona, lang),
      messages: [
        {
          role: "user",
          content:
            "다음은 내 사주·점성술 계산 결과다. 이 페르소나로 나만을 위한 해석을 써줘.\n\n" +
            JSON.stringify(chart, null, 2),
        },
      ],
    });
    const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!text) return res.status(502).json({ error: "빈 응답", raw: JSON.stringify(msg).slice(0, 400) });
    return res.status(200).json({ reading: text });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e), name: e?.name, status: e?.status });
  }
}
