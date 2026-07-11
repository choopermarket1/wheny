// 후기(리뷰) 저장·조회 — Upstash Redis REST 사용. 키 없으면 needSetup으로 안전 폴백.
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const URL = process.env.UPSTASH_REDIS_REST_URL;
  const TOK = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!URL || !TOK) return res.status(200).json({ ok: false, needSetup: true, reviews: [], avg: 0, count: 0 });

  const cmd = (arr) =>
    fetch(URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + TOK, "Content-Type": "application/json" },
      body: JSON.stringify(arr),
    }).then((r) => r.json());

  try {
    if (req.method === "POST") {
      let b = req.body;
      if (typeof b === "string") { try { b = JSON.parse(b); } catch (_) { b = {}; } }
      const rating = Math.max(1, Math.min(5, parseInt(b.rating, 10) || 5));
      const name = String(b.name || "").slice(0, 20).replace(/[<>]/g, "").trim() || "익명";
      const text = String(b.text || "").slice(0, 300).replace(/[<>]/g, "").trim();
      const lang = String(b.lang || "ko").slice(0, 2);
      if (text.length < 5) return res.status(400).json({ ok: false, error: "too_short" });

      // 스팸 방지: IP당 10분 3회
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "x";
      const rl = await cmd(["INCR", "wheny:rl:rev:" + ip]);
      if (rl.result === 1) await cmd(["EXPIRE", "wheny:rl:rev:" + ip, "600"]);
      if ((rl.result || 0) > 3) return res.status(429).json({ ok: false, error: "too_many" });

      const item = JSON.stringify({ r: rating, n: name, t: text, l: lang, d: Date.now() });
      await cmd(["LPUSH", "wheny:reviews", item]);
      await cmd(["LTRIM", "wheny:reviews", "0", "499"]);
      return res.status(200).json({ ok: true });
    }

    // GET — 최근 후기 + 평균
    const data = await cmd(["LRANGE", "wheny:reviews", "0", "59"]);
    const reviews = (data.result || [])
      .map((s) => { try { return JSON.parse(s); } catch (_) { return null; } })
      .filter(Boolean);
    const count = reviews.length;
    const avg = count ? Math.round((reviews.reduce((a, x) => a + (x.r || 0), 0) / count) * 10) / 10 : 0;
    return res.status(200).json({ ok: true, reviews, avg, count });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e).slice(0, 100), reviews: [], avg: 0, count: 0 });
  }
}
