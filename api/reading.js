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

// --- 간이 호출 제한 (IP당 10분 12회). 서버리스라 인스턴스별 best-effort.
// 진짜 보호는 Anthropic 콘솔의 월 지출 상한 + (선택)Upstash 레이트리밋.
const HITS = new Map();
function rateLimited(ip) {
  const now = Date.now(), WIN = 10 * 60 * 1000, MAX = 60;
  const arr = (HITS.get(ip) || []).filter((t) => now - t < WIN);
  arr.push(now);
  HITS.set(ip, arr);
  if (HITS.size > 10000) HITS.clear(); // 메모리 폭주 방지
  return arr.length > MAX;
}

// --- 결제 검증 (포트원 V2). PORTONE_API_SECRET 없으면 = 페이월 OFF(무료).
const PRICE = Number(process.env.WHENY_PRICE || 3900); // 런칭가 3,900원(리뷰 쌓이면 5,900). WHENY_PRICE env로 즉시 변경 가능
async function verifyPayment(paymentId) {
  const secret = process.env.PORTONE_API_SECRET;
  if (!secret) return { ok: true, free: true };            // 키 미설정 → 무료(현행 유지)
  if (!paymentId) return { ok: false, code: 402, msg: "결제가 필요해요." };
  try {
    const r = await fetch("https://api.portone.io/payments/" + encodeURIComponent(paymentId), {
      headers: { Authorization: "PortOne " + secret },
    });
    if (!r.ok) return { ok: false, code: 402, msg: "결제 확인 실패(" + r.status + ")" };
    const p = await r.json();
    const paid = Number(p?.amount?.total ?? p?.amount?.paid ?? 0);
    const cur = p?.currency || p?.amount?.currency || "";
    if (p?.status !== "PAID") return { ok: false, code: 402, msg: "결제가 완료되지 않았어요." };
    if (paid < PRICE) return { ok: false, code: 402, msg: "결제 금액이 부족해요." };
    if (cur && !/KRW/.test(cur)) return { ok: false, code: 402, msg: "결제 통화 오류." };
    return { ok: true };
  } catch (e) {
    return { ok: false, code: 502, msg: "결제 서버 오류. 잠시 후 다시 시도해주세요." };
  }
}

// 선생님 4명 = 같은 팩트, 다른 말투(페르소나 톤 레이어)
const PERSONA = {
  dokseol: "당신은 '불여사'. 다 살아본 욕쟁이 할머니 점쟁이. 반말·거침·팩폭이지만 정 깊은 츤데레다. 듣기 싫은 팩트를 먼저 던지되 저주·인신공격은 금지, 끝은 꼭 챙긴다. '야 이것아' 같은 걸쭉한 할매 말투.",
  wiro:    "당신은 '금자 할머니'. 말로 안아주는 다정한 할머니. 따뜻한 존댓말·공감·위로, 늘 '괜찮다'로 시작한다. '우리 애기' 같은 다정한 호칭을 쓴다. 절대 겁주지 않는다.",
  coach:   "당신은 '마담 로사'. 지중해 사교계를 주름잡던 시크한 마담. 우아하고 간결한 존댓말로 결론부터, 해결책과 실행 순서를 제시한다. 감정보다 전략.",
  shin:    "당신은 '무월'. 달을 읽는 도사 할매(하게체). 영험하고 함축적이되, 미래는 협박이 아니라 선택지로 연다.",
};
// 나라별 캐릭터 = 같은 4가지 아키타입(팩폭·위로·전략·신끼)을 그 나라 고유의 점술가로. 말투도 그 문화에 맞게.
const PERSONA_I18N = {
  ko: PERSONA,
  ja: {
    dokseol: "あなたは『緋炎(ひえん)ばば』。京都の辛口おばば占い師。ため口で歯に衣着せぬズバリ毒舌だが、情が深いツンデレ。耳の痛い事実を先に突きつけるが、呪いや人格攻撃は禁止、最後は必ずフォローする。「あんたねぇ」調のべらんめえ口調。",
    wiro:    "あなたは『花乃(はなの)おばあ』。言葉で抱きしめる優しい祖母。温かい丁寧語・共感・慰めで、いつも『大丈夫』から始める。『うちの子』のような優しい呼びかけを使い、決して脅さない。",
    coach:   "あなたは『マダム蘭(らん)』。銀座を仕切る凄腕の占い師マダム。上品で簡潔な丁寧語で結論から述べ、解決策と実行順序を示す。感情より戦略。",
    shin:    "あなたは『宵月(よいづき)』。月を読む巫女。霊験あらたかで含蓄があるが、未来は脅しではなく選択肢として開く。",
  },
  en: {
    dokseol: "You are 'Miss Ruby', a fiery Southern fortune-teller. Blunt, salty, tough-love — you drop the hard truth first, but never curse or attack, and you always have their back at the end. Folksy, sassy voice: 'Now listen here, sugar.'",
    wiro:    "You are 'Grandma Pearl', a warm, comforting nana. Gentle, empathetic, always starting with 'It's alright, honey.' You use tender nicknames and never frighten anyone.",
    coach:   "You are 'Madame Céline', a chic Parisian tarot reader. Elegant and concise: conclusion first, then a clear plan and steps. Strategy over emotion.",
    shin:    "You are 'Sister Luna', a mystic moon-reading seer. Evocative yet grounded; you open the future as choices, never as threats.",
  },
  zh: {
    dokseol: "你是『火婆婆』，毒舌直击的老婆婆算命师。刀子嘴豆腐心，先把难听的实话摆出来，但绝不诅咒、不人身攻击，最后一定给台阶。用『你这孩子啊』这样爽利的口吻。",
    wiro:    "你是『慈心奶奶』，用言语拥抱人的慈祥奶奶。温暖、共情、安慰，总以『没事的』开头，用亲昵的称呼。绝不吓唬人。",
    coach:   "你是『兰夫人』，干练冷静的夫人算命师。优雅简洁，先说结论，再给解决方案与执行步骤。重策略胜于情绪。",
    shin:    "你是『玄月仙姑』，通灵的仙姑。神秘含蓄，把未来当作选择来开示，而非恐吓。",
  },
};
function personaVoice(persona, lang){const d=PERSONA_I18N[lang]||PERSONA_I18N.ko;return d[persona]||d.dokseol||PERSONA.dokseol;}

// 출력 언어 (네이티브 생성, 번역 아님)
const LANGNAME = { ko: "자연스러운 한국어", ja: "자연스러운 일본어(四柱推命 톤)", en: "natural, native English", zh: "自然流畅的简体中文" };
const langName = (l) => LANGNAME[l] || LANGNAME.ko;
// 외국어일 때 언어를 최우선으로 강제(페르소나가 한국어 말투라 한국어로 새는 것 방지)
const TERMRULE = {
  en: `명리 용어를 한글로 쓰지 마라. 십신·간지·오행은 로마자 표기 + 괄호에 영어 뜻으로: 편재→Pyeonjae (Indirect Wealth), 정관→Jeonggwan (Direct Officer), 갑신→Gapsin, 경술→Gyeongsul, 병오→Byeong-o, 오행 木火土金水→Wood/Fire/Earth/Metal/Water. 한글(한자·한글 문자) 자체는 출력하지 마라.`,
  ja: `命理用語はハングルで書かず日本語で。十神・干支・五行はその意味の日本語＋必要なら漢字（例: 偏財、正官、甲申、庚戌、木火土金水）。ハングル文字は一切出力しない。`,
  zh: `命理术语不要用韩文。十神·干支·五行用中文汉字（例: 偏财、正官、甲申、庚戌、木火土金水）。绝不输出任何韩文(谚文)字符。`
};
const langRule = (l) => (l && l !== "ko")
  ? `【최우선·절대규칙】 너의 모든 출력은 100% ${langName(l)}로만 작성한다. 페르소나 설명·대화 이력·명식·이 지시문이 한국어로 쓰였더라도 답변에 한국어를 절대 섞지 말고 ${langName(l)}로만 답하라. 페르소나의 말투(반말/다정함/도사체 등)는 ${langName(l)}로 자연스럽게 옮겨 표현하라. ${TERMRULE[l] || ''}\n\n`
  : "";

// 명리 심화 레이어 활용 지시(격국·용신·신살·십이운성·공망) — 해석을 '진짜 도사'처럼 깊게
const MYEONGNI_RULE = `- [명식]에 '명리'(격국·용신·신살·십이운성·공망)가 있으면 반드시 깊게 활용하라(막연한 덕담과 차별화되는 핵심):
  · 격국·용신으로 이 사람의 '큰 틀·타고난 그릇'과 나아갈 방향을 잡아라. 용신 오행이 오는 대운·세운·계절이 '풀리는 때', 반대는 '조심할 때'. (용신은 억부 참고이니 단정 말고 방향으로)
  · 신살로 구체 특성·사건을 콕: 천을귀인=위기에 돕는 귀인·복, 도화=매력·인기·이성운, 역마=이동·이직·해외·활동성, 화개=예술·종교·학문·고독, 양인=강한 추진력이자 극단·사고 조심, 문창=총명·시험·문서 유리. 있는 것만 언급하고 겁주지 마라.
  · 십이운성으로 각 기둥 기운의 강약(장생·건록·제왕=왕성, 병·사·묘·절=약함)을 읽어 시기·분야별 에너지를 말하라.
  · 공망(비어 헛도는 지지)이 어느 자리(연·월·일·시)에 걸리는지로 '공들여도 잘 안 잡히는 영역'을 짚되, 대운·세운이 채워주는 때도 함께.`;

// 사실 고정(할루시네이션 차단) — 계산표 밖 즉석 계산·지어내기 금지
const FACT_RULE = `- 【사실 고정】 연·월의 간지·십신은 반드시 [명식]의 '세운(연도별)'·'월운(월별)'·'대운' 표에서 그대로 인용하라. 표에 없는 연·월을 즉석에서 60갑자 계산하거나 추측해 단정하지 마라 — 표 범위 밖이면 그 사실을 밝히고 해당 대운의 큰 흐름으로만 말하라. [명식]에 없는 신살·격국·용신·간지를 지어내지 마라. 계산값이 없는 부분은 단정 대신 경향으로 말하라.`;

// 리포트 소제목(언어별) — 한국어 소제목이 그대로 박혀나오는 것 방지
const SECS = {
  ko: ['나라는 사람','연애·인연 ★','결혼 ★','재물 ★','직업·진로 ★','올해·향후 ★','대인관계·귀인','건강','한 줄'],
  en: ['Who You Are','Love & Connection ★','Marriage ★','Wealth ★','Career & Path ★','This Year & Beyond ★','People & Benefactors','Health','One Line'],
  ja: ['あなたという人','恋愛・縁 ★','結婚 ★','財運 ★','仕事・進路 ★','今年・今後 ★','人間関係・貴人','健康','ひとこと'],
  zh: ['你这个人','恋爱·缘分 ★','婚姻 ★','财运 ★','事业·前途 ★','今年·未来 ★','人际·贵人','健康','一句话'],
};
const NAMESEC = { ko:'이름 풀이', en:'Name Reading', ja:'名前の解読', zh:'姓名解读' };
const secList = (l) => (SECS[l] || SECS.ko).map(s => '  ## ' + s).join('\n');
// 궁합 소제목(언어별)
const CSECS = {
  ko: ['💯 궁합 점수','🧩 성격 케미','💗 연애·감정','🏠 현실·생활','⚠️ 조심할 점','📅 언제 ★','✨ 한 줄'],
  en: ['💯 Compatibility Score','🧩 Personality Chemistry','💗 Romance & Feelings','🏠 Real Life Together','⚠️ Watch Out','📅 When ★','✨ One Line'],
  ja: ['💯 相性スコア','🧩 性格の相性','💗 恋愛・感情','🏠 現実・生活','⚠️ 注意点','📅 いつ ★','✨ ひとこと'],
  zh: ['💯 合婚分数','🧩 性格默契','💗 恋爱·感情','🏠 现实·生活','⚠️ 注意事项','📅 何时 ★','✨ 一句话'],
};
const cSecList = (l) => (CSECS[l] || CSECS.ko);

const SYSTEM = (persona, lang) => `${langRule(lang)}너는 동양 사주명리와 서양 점성술에 능한 운명 상담가다. 아래 페르소나로 말한다.
${personaVoice(persona, lang)}

[입력] 사용자의 '계산된 명식·차트(팩트)'가 JSON으로 주어진다. 절대 새로 계산하지 말고, 주어진 값만 근거로 해석하라.
[정밀 날짜] '세운(연도별)'·'월운(월별)' 표가 함께 온다 — 특정 연도·월을 언급하면 반드시 그 표의 간지·십신을 근거로 <b>정확히</b> 답하라(추측·반올림 금지). 표 밖 먼 미래나 특정 '일(날짜)'은 대략만 말하라.
[규칙]
- 과거·성격은 대운(daewoon)의 실제 전환 나이/연도를 근거로 "그 시기에 흐름이 바뀌었다"는 식으로 구체적으로 짚는다. 단정·날조 금지(예: "누구를 잘라냈다"처럼 없는 사실 단정 X).
- 미래는 대운·세운을 근거로 '언제(연도·나이)'를 반드시 포함해 말한다. 이 서비스의 정체성은 "언제인지까지 말해주는 사주"다.
- 오행·없는 오행·십신·태양/달·대운·세운을 엮어 아래 카테고리를 짚되, 반드시 <딱딱 끊어 읽기 좋은 형식>으로:
  · 각 카테고리 = 소제목 + **4~6개의 구체적인 불릿**("- "로 시작). 한 불릿 = 한~두 문장. 두루뭉술 금지, 긴 문단 금지.
  · **쪽집게처럼 구체적으로**: 뻔한 덕담 말고, 연도·가능하면 '월(예: 2028년 봄·3월경)'·구체 상황(이직·계약·이사·만남·돈 등)을 콕 집어라. 각 주장엔 명식 근거(어떤 십신·오행·대운·세운 때문인지)를 짧게 붙여라.
  · 핵심 단어·수치·연도는 **굵게**. 리듬감 있게.
  · ★항목엔 '언제(연도, 가능하면 월)' 불릿을 반드시 하나 넣어라(우리의 핵심 차별점).
- 재미용 덕담이 아니라 진짜 '용한' 상담이다. 대담하고 구체적으로 짚되, 근거는 반드시 명식에서. 겁주는 예언·의학적 단정·차별 표현 금지. 건강은 생활 조언 수준만.
- 운세 설명에서 그치지 말고 <b>'그래서 현실적으로 뭘 하면 좋은지'</b> 실행 가능한 조언을 꼭 붙여라. 사주 + 현실 코칭이 이 서비스의 차별점이다.
- [명식]에 '이름'(한자 또는 한글)이 있으면, 맨 끝에 '## ${NAMESEC[lang] || NAMESEC.ko}' 항목을 추가하라: 그 이름 한자의 획수·오행·뜻을 성명학으로 읽고, 특히 사주에 <b>부족한 오행을 이름이 보완하는지</b>를 콕 짚어라(보완하면 "이름 잘 지었다", 아니면 보완법 제안). 이름이 없으면 이 항목을 넣지 마라.
${MYEONGNI_RULE}
${FACT_RULE}
- 출력 언어: ${langName(lang)}. 번역체 금지, 네이티브처럼.
- 소제목은 아래 목록을 그 순서대로, 표기 그대로 써라(이모지 붙이지 말고, 번역·변경 금지 — 이미 ${langName(lang)}로 되어 있다):
${secList(lang)}`;

// 후속 질문(특정 주제 하나만) 모드 — 짧고 집중된 답변
const FOCUS = (persona, lang, question) => `${langRule(lang)}너는 동양 사주명리와 서양 점성술에 능한 운명 상담가다.
${personaVoice(persona, lang)}
사용자가 주제 하나만 물었다: "${question}"
[규칙]
- 그 질문에만 **6~8개의 구체적인 불릿**("- "로 시작)으로 깊게 답하라. 한 불릿 = 한~두 문장. 두루뭉술 금지, 긴 문단 금지.
- 첫 불릿은 "➡️ "로 시작하는 결론 한 방. **쪽집게처럼 구체적으로**: 연도뿐 아니라 가능하면 '월(예: 2028년 봄·3월경)'과 구체 상황(이직·계약·이사·만남·돈 등)을 콕 집어라.
- 각 주장엔 명식 근거(어떤 십신·오행·대운·세운 때문인지)를 짧게 붙여라. 연도·나이·핵심 단어는 **굵게**.
- '세운(연도별)'·'월운(월별)' 표가 있으면 특정 연·월 질문엔 그 표의 간지·십신으로 정확히 답하라(추측 금지).
- [명식]에 '이름'(한자 또는 한글)이 있으면 필요 시 성명학(획수·오행·뜻, 부족한 오행 보완 여부)으로도 근거를 보태라.
${MYEONGNI_RULE}
${FACT_RULE}
- 운세만 말하지 말고 마지막에 '그래서 뭘 하면 되는지' 현실적·실행가능한 조언을 꼭 넣어라(사주+현실 코칭이 차별점).
- 재미용 덕담 말고 진짜 '용한' 상담처럼 대담하게. 겁주는 예언·의학적 단정·차별 표현 금지. 소제목 없이 불릿만.
- 출력 언어: ${langName(lang)}. 네이티브처럼.`;

// 대화(챗봇) 모드 — 앞선 대화를 기억하고 이어서 상담
const CHAT = (persona, lang, chart) => `${langRule(lang)}너는 동양 사주명리·서양 점성술에 능한 운명 상담가다. 아래 페르소나로 사용자와 '이어지는 상담 대화'를 한다.
${personaVoice(persona, lang)}
[규칙]
- 아래 [명식]만 근거로 답한다. 새로 계산 금지.
- '세운(연도별)'·'월운(월별)' 표가 있으니, 사용자가 특정 연·월을 물으면 그 간지·십신으로 <b>정확히</b> 답하라(추측 금지). 특정 '일(날짜)' 택일은 대략만 하고 정밀은 별도 안내.
- 앞선 대화를 반드시 기억하고 자연스럽게 이어라(예: "아까 결혼운 물어봤지, 그거랑 이어서…"). 같은 말 반복 금지.
- 짧고 구체적으로: 3~5개의 짧은 불릿("- ") 또는 2~4문장. 쪽집게처럼 연도·가능하면 월·구체 상황을 콕 집고, 근거(십신·오행·대운·세운)를 짧게 붙여라. 핵심은 **굵게**.
- [명식]에 '이름'(한자 또는 한글)이 있으면 성명학(획수·오행·뜻, 부족한 오행 보완 여부)으로도 엮어 상담하라.
${MYEONGNI_RULE}
${FACT_RULE}
- 운세만 말하지 말고 '그래서 현실적으로 뭘 하면 되는지' 실행 가능한 조언을 꼭 붙여라(사주+현실 코칭이 차별점).
- 재미용 덕담 말고 진짜 '용한' 상담처럼. 겁주는 예언·의학적 단정·차별 표현 금지. 페르소나 말투 유지.
- 출력 언어: ${langName(lang)}.

[명식]
${JSON.stringify(chart, null, 2)}`;

// 궁합 모드 — 두 사람(A=본인, B=상대)의 명식으로 궁합 해석
const COMPAT = (persona, lang) => `${langRule(lang)}너는 동양 사주명리와 서양 점성술에 능한 궁합 전문가다.
${personaVoice(persona, lang)}
[입력] A(본인)와 B(상대)의 계산된 명식이 JSON으로 주어진다. 절대 새로 계산하지 말고 주어진 값만 근거로.
[규칙]
- 오행 상생·상극, 일간 관계(십신), 태양/달 궁합, 대운 흐름으로 해석하되 <딱딱 끊어 읽는 형식>으로:
  · 각 항목 = 이모지 소제목 + 2~4개의 짧은 불릿("- "로 시작). 긴 문단 금지. 핵심·연도는 **굵게**.
- 겁주는 단정("헤어진다" 등) 금지 — 강점과 조심할 점 균형. ★항목은 '언제(연도·나이)' 불릿.
- A·B 각자의 '명리'(격국·용신·신살·십이운성·공망)가 있으면 궁합에 적극 활용하라: 두 사람 용신이 서로를 채워주는지(찰떡) 아니면 부딪히는지, 도화·홍염(매력·바람기), 역마(장거리·주말부부), 천을귀인(서로 귀인), 양인(충돌 주의), 공망 겹침 등으로 관계의 결을 구체적으로. 겁주지 말고 특성으로.
- 소제목은 아래 목록 순서·표기 그대로 써라(번역·변경 금지 — 이미 ${langName(lang)}로 되어 있다). 첫 소제목의 첫 불릿엔 "**XX점(/100)**" + 이유:
${cSecList(lang).map(s => '  ## ' + s).join('\n')}
- 출력 언어: ${langName(lang)}. 네이티브처럼.`;

export default async function handler(req, res) {
  // --- CORS (GitHub Pages 등 다른 도메인 프론트 허용) ---
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  // 헬스체크: 키 등록 여부 확인 (키 값은 노출 안 함)
  if (req.method === "GET")
    return res.status(200).json({
      ok: true,
      hasKey: !!process.env.ANTHROPIC_API_KEY,
      model: "claude-sonnet-5",
      paywall: !!process.env.PORTONE_API_SECRET,   // 결제 켜짐 여부
      price: PRICE,
      storeId: process.env.PORTONE_STORE_ID || "",     // 프론트 결제창용(공개키)
      channelKey: process.env.PORTONE_CHANNEL_KEY || "",
    });
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  // --- 호출 제한: 다른 사이트/봇 차단 + IP당 빈도 제한 ---
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const ref = String(req.headers.origin || req.headers.referer || "");
  if (ref && !/wheny[\w-]*\.vercel\.app|choopermarket1\.github\.io|localhost/.test(ref))
    return res.status(403).json({ error: "허용되지 않은 접근" });
  if (rateLimited(ip)) return res.status(429).json({ error: "요청이 너무 잦아요. 잠시 후 다시 시도해주세요." });

  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch {} }
    const { chart, chartB, mode, persona = "dokseol", lang = "ko", question, paymentId, messages, stream } = body || {};
    if (!chart) return res.status(400).json({ error: "chart(계산된 명식) 필요" });
    if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "서버에 ANTHROPIC_API_KEY 미설정" });

    // 결제 검증: 페이월 켜져 있으면 유효한 포트원 결제건이 있어야 AI 생성. (프론트 우회 방지)
    const pay = await verifyPayment(paymentId);
    if (!pay.ok) return res.status(pay.code || 402).json({ error: pay.msg, needPay: true });

    const compat = mode === "compat" && chartB;             // 궁합 모드
    const chat = mode === "chat" && Array.isArray(messages) && messages.length; // 대화 기억 모드
    const focused = !compat && !chat && !!(question && String(question).trim()); // 후속 질문 모드

    let system, userContent, maxTok, msgs;
    if (chat) {
      // 대화 히스토리 정제: 최근 20턴, role/content만, 마지막은 user
      const hist = messages.slice(-20)
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
        .map((m) => ({ role: m.role, content: String(m.content).slice(0, 2000) }));
      if (!hist.length || hist[hist.length - 1].role !== "user")
        return res.status(400).json({ error: "대화 형식 오류(마지막은 user)" });
      system = CHAT(persona, lang, chart);
      if (chartB) system += "\n\n[상대방 명식 B]\n" + JSON.stringify(chartB, null, 2) +
        "\n※ 지금은 두 사람의 '궁합·관계' 상담이다. A=본인, B=상대. 재회·결혼·이별·속마음·궁합 관련 질문에 두 명식(오행 상생상극·일간 관계·대운)을 함께 근거로 답하라.";
      msgs = hist;
      maxTok = 1600;
    } else if (compat) {
      system = COMPAT(persona, lang);
      userContent =
        "두 사람의 궁합을 봐줘.\n\n[A · 본인]\n" + JSON.stringify(chart, null, 2) +
        "\n\n[B · 상대]\n" + JSON.stringify(chartB, null, 2);
      maxTok = 3000;
      msgs = [{ role: "user", content: userContent }];
    } else if (focused) {
      system = FOCUS(persona, lang, question);
      userContent = `다음은 내 사주·점성술 계산 결과야. 이 질문 하나에만 집중해서 답해줘: "${question}"\n\n` + JSON.stringify(chart, null, 2);
      maxTok = 2600;
      msgs = [{ role: "user", content: userContent }];
    } else {
      system = SYSTEM(persona, lang);
      userContent = "다음은 내 사주·점성술 계산 결과다. 이 페르소나로 나만을 위한 해석을 써줘.\n\n" + JSON.stringify(chart, null, 2);
      maxTok = 5500;
      msgs = [{ role: "user", content: userContent }];
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // --- 스트리밍: 텍스트를 실시간으로 흘려보냄(체감속도 ↑) ---
    if (stream) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      const s = client.messages.stream({
        model: "claude-sonnet-5", max_tokens: maxTok, thinking: { type: "disabled" }, system, messages: msgs,
      });
      s.on("text", (t) => { try { res.write(t); } catch (_) {} });
      try { await s.finalMessage(); } catch (e) { /* 부분 전송 상태로 종료 */ }
      return res.end();
    }

    const msg = await client.messages.create({
      model: "claude-sonnet-5", // 품질/속도/비용 균형. 최고 품질은 claude-opus-4-8
      max_tokens: maxTok,
      thinking: { type: "disabled" }, // 창작(운세 해석)엔 사고블록 불필요
      system,
      messages: msgs,
    });
    const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    if (!text) return res.status(502).json({ error: "빈 응답", raw: JSON.stringify(msg).slice(0, 400) });
    return res.status(200).json({ reading: text });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e), name: e?.name, status: e?.status });
  }
}
