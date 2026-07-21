import { config } from "dotenv";

// ローカル実行用に .env.local を読む。GitHub Actions では secrets が process.env にあり no-op。
config({ path: ".env.local" });

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../lib/supabase/admin";
import { nextMastery, buildCategoryMastery, scoreQuestion } from "../lib/learn/mastery";
import { padEndWide, padStartWide } from "./_report-format";
import type { QuizDifficulty, QuizQuestion } from "../lib/types";

// YAT-60: mastery パラメータ較正のための replay 診断スクリプト。
// mastery.ts の冒頭が「較正・再計算の退路は元帳（quiz_attempts）から nextMastery を replay する
// ことで残す」と予告している、その replay の読み取り側を実装したもの。
// topic_mastery は EWMA キャッシュなので、パラメータを変えても過去には遡及しない。元帳を時系列で
// 畳み直せば任意パラメータでの mastery 軌跡が再構成でき、較正の効果を事前に比較できる。
//
// 書き戻し（topic_mastery の backfill）はやらない。パラメータが確定してから YAT-56 で行う。
// 読み取り専用。DB は一切書き換えない。LLM 呼び出しが無いので課金は発生しない。
//
// パラメータ差し替えの都合: mastery.ts の MASTERY_PRIOR / MASTERY_ALPHA は非 export のため、
// 本スクリプトは更新式をローカルに再実装する。ただし**現行パラメータの系列は本物の nextMastery で
// 回して両者の一致を assert する**（再実装が本番から乖離したまま較正すると、測った数字の意味が
// 失われるため。YAT-58 で計測と本番の乖離を実際に踏んだ教訓）。

const SELECT_PAGE = 1000; // PostgREST 既定の 1 ページ上限。元帳は全件必要なので .range() で回す
const TOP_CONCEPTS = 15; // 軌跡を詳細表示する concept 数（attempts 降順）

// 現行値（mastery.ts:17-24 の写し。非 export のためここに複製する。
// 下の assertAlphaMatches / assertPriorMatches が本物と突き合わせて写し間違いを検出する）。
const CURRENT: MasteryParams = {
  prior: 0.3,
  alpha: {
    easy: { correct: 0.15, wrong: 0.4 },
    medium: { correct: 0.25, wrong: 0.25 },
    hard: { correct: 0.4, wrong: 0.15 },
  },
};

// 較正候補。ここを編集して比較する（tunable）。
const CANDIDATES: { name: string; params: MasteryParams }[] = [
  { name: "現行", params: CURRENT },
  {
    name: "prior 0.5",
    params: { ...CURRENT, prior: 0.5 },
  },
  {
    name: "alpha 半減（緩やか）",
    params: {
      prior: CURRENT.prior,
      alpha: {
        easy: { correct: 0.075, wrong: 0.2 },
        medium: { correct: 0.125, wrong: 0.125 },
        hard: { correct: 0.2, wrong: 0.075 },
      },
    },
  },
  {
    name: "alpha 倍化（機敏）",
    params: {
      prior: CURRENT.prior,
      alpha: {
        easy: { correct: 0.3, wrong: 0.8 },
        medium: { correct: 0.5, wrong: 0.5 },
        hard: { correct: 0.8, wrong: 0.3 },
      },
    },
  },
];

type MasteryParams = {
  prior: number;
  alpha: Record<QuizDifficulty, { correct: number; wrong: number }>;
};

type AttemptRow = {
  concept_key: string;
  difficulty: string;
  is_correct: boolean;
  created_at: string;
};

type TopicRow = {
  concept_key: string;
  concept_label: string;
  category: string;
  mastery: number;
  attempts: number;
};

// mastery.ts の safeDifficulty（非 export）と同じフォールバック。difficulty 列は text で制約が無い。
function safeDifficulty(d: string): QuizDifficulty {
  return d === "easy" || d === "hard" ? d : "medium";
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// nextMastery の再実装（パラメータを差し替えられる形）。式は mastery.ts:56-58 と同一。
function nextWith(prev: number, difficulty: QuizDifficulty, isCorrect: boolean, p: MasteryParams): number {
  const a = p.alpha[difficulty][isCorrect ? "correct" : "wrong"];
  const target = isCorrect ? 1 : 0;
  return clamp01(prev + a * (target - prev));
}

// 再実装が本番の nextMastery と一致することを確認する。ここが落ちたら以降の数字は信用できないので
// 即座に止める（乖離したまま較正すると YAT-58 と同じ「計測が本番と別物」を繰り返す）。
// nextMastery は prev に対してアフィン（傾き 1-a）で prev,a∈[0,1] なら clamp は不活性なので、
// 3 難易度 × 正誤 × prev 5 点で alpha 側は必要十分に押さえられる。
function assertAlphaMatches() {
  const diffs: QuizDifficulty[] = ["easy", "medium", "hard"];
  for (const d of diffs) {
    for (const correct of [true, false]) {
      for (const prev of [0, 0.3, 0.5, 0.87, 1]) {
        const mine = nextWith(prev, d, correct, CURRENT);
        const real = nextMastery(prev, d, correct);
        if (Math.abs(mine - real) > 1e-12) {
          console.error(
            `再実装が本番 nextMastery と不一致: prev=${prev} ${d} correct=${correct}` +
              ` → 再実装 ${mine} / 本番 ${real}`,
          );
          console.error("mastery.ts の MASTERY_ALPHA が変わった可能性がある。CURRENT.alpha を更新すること。");
          process.exit(1);
        }
      }
    }
  }
}

// prior は nextMastery が参照しないので上の assert では検出できない（alpha だけ守っても
// CURRENT.prior の写し間違いは素通りする）。prior は各 concept の初回 attempt の prev に直接
// 入るため、ズレると attempts の少ない concept が丸ごと狂う。
// scoreQuestion が未登録 concept の既定値として MASTERY_PRIOR を使う（row?.mastery ?? PRIOR）
// ことを利用し、「空 map で採点した値」と「CURRENT.prior を入れた map で採点した値」の一致を
// 見ることで、非 export のまま間接的に検証する。
function assertPriorMatches() {
  const q: QuizQuestion = {
    id: "probe",
    concept_key: "probe-concept",
    concept_label: "probe",
    category: "tech/programming",
    difficulty: "medium",
    stem: "probe",
    choices: ["a", "b", "c", "d"],
    answer_index: 0,
    explanation: "probe",
    source_quote: null,
    grounded: false,
    source_ref: null,
  };
  const nowMs = 0;
  const rng = () => 0.5; // jitter を固定して差分を prior 由来だけにする
  const withEmpty = scoreQuestion(q, new Map(), nowMs, rng);
  const withPrior = scoreQuestion(
    q,
    new Map([[q.concept_key, { mastery: CURRENT.prior, last_served_at: null }]]),
    nowMs,
    rng,
  );
  if (Math.abs(withEmpty - withPrior) > 1e-12) {
    console.error(
      `CURRENT.prior (${CURRENT.prior}) が本番 MASTERY_PRIOR と一致しない` +
        `（scoreQuestion の既定値経由で検出: 空 map ${withEmpty} / prior 指定 ${withPrior}）`,
    );
    console.error("mastery.ts の MASTERY_PRIOR を確認して CURRENT.prior を更新すること。");
    process.exit(1);
  }
}

// 元帳を .range() で全件ページ取得する。窓で絞ると replay が壊れるので全件必要。
// created_at 昇順（既存 index は desc だが、畳み込みは時系列順でなければ非対称 α のせいで値が変わる）。
// 同一 created_at でのページ境界の取りこぼしを防ぐため id を二次キーにする。
async function loadAllAttempts(supabase: SupabaseClient): Promise<AttemptRow[]> {
  const out: AttemptRow[] = [];
  for (let from = 0; ; from += SELECT_PAGE) {
    const { data, error } = await supabase
      .from("quiz_attempts")
      .select("concept_key, difficulty, is_correct, created_at")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + SELECT_PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as AttemptRow[];
    out.push(...batch);
    if (batch.length < SELECT_PAGE) break;
  }
  return out;
}

// 元帳を畳んで concept ごとの mastery を出す。初回のみ prior を使う規則は
// recordQuizAttempt（mastery.ts:93-94）の「attempts===0 なら prior」と等価。
function replay(attempts: AttemptRow[], p: MasteryParams): Map<string, { mastery: number; n: number }> {
  const acc = new Map<string, { mastery: number; n: number }>();
  for (const a of attempts) {
    const cur = acc.get(a.concept_key);
    const prev = cur === undefined ? p.prior : cur.mastery;
    const m = nextWith(prev, safeDifficulty(a.difficulty), a.is_correct, p);
    acc.set(a.concept_key, { mastery: m, n: (cur?.n ?? 0) + 1 });
  }
  return acc;
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

async function main() {
  assertAlphaMatches();
  assertPriorMatches();

  const supabase = createAdminClient();
  const attempts = await loadAllAttempts(supabase);
  if (attempts.length === 0) {
    console.log("=== mastery replay 診断（YAT-60） ===");
    console.log("quiz_attempts が空です。回答が貯まってから再実行してください。");
    return;
  }

  const { data: topicData, error: topicErr } = await supabase
    .from("topic_mastery")
    .select("concept_key, concept_label, category, mastery, attempts");
  if (topicErr) {
    console.error("topic_mastery の取得に失敗:", topicErr);
    process.exit(1);
  }
  const topics = (topicData ?? []) as unknown as TopicRow[];
  const topicByKey = new Map(topics.map((t) => [t.concept_key, t]));

  console.log("=== mastery replay 診断（YAT-60） ===");
  console.log(
    `元帳 ${attempts.length} attempts / concept ${new Set(attempts.map((a) => a.concept_key)).size} 件` +
      ` / topic_mastery ${topics.length} 行`,
  );
  console.log(
    `期間: ${attempts[0].created_at.slice(0, 10)} 〜 ${attempts[attempts.length - 1].created_at.slice(0, 10)}`,
  );
  const correctRate = attempts.filter((a) => a.is_correct).length / attempts.length;
  const byDiff = new Map<string, number>();
  for (const a of attempts) byDiff.set(a.difficulty, (byDiff.get(a.difficulty) ?? 0) + 1);
  console.log(
    `素正答率 ${(correctRate * 100).toFixed(1)}% / difficulty 内訳 ` +
      [...byDiff].map(([d, n]) => `${d}=${n}`).join(" "),
  );

  // ── replay と実キャッシュの整合 ───────────────────────────────────────
  // quiz_attempts.question_id は on delete cascade。問題が削除されると attempt 行も消えるため、
  // 元帳は厳密には不滅ではない。乖離があれば cascade 欠損か YAT-27 以前の残留かの切り分け材料になる。
  const base = replay(attempts, CURRENT);
  let matched = 0;
  let drifted = 0;
  const driftExamples: { key: string; replayed: number; stored: number; nR: number; nS: number }[] = [];
  for (const [key, r] of base) {
    const t = topicByKey.get(key);
    if (!t) continue;
    if (Math.abs(r.mastery - t.mastery) < 5e-3 && r.n === t.attempts) matched += 1;
    else {
      drifted += 1;
      if (driftExamples.length < 5) {
        driftExamples.push({ key, replayed: r.mastery, stored: t.mastery, nR: r.n, nS: t.attempts });
      }
    }
  }
  // topic_mastery にあるのに元帳へ 1 行も残っていない concept。question 削除の cascade で
  // attempt が全滅した最極端ケースで、base 側のループだけでは数え落とす（このセクションの
  // 目的がまさに元帳欠損の検出なので、取りこぼすと健全に見えてしまう）。
  const orphans = topics.filter((t) => !base.has(t.concept_key));

  console.log(`\n--- replay と topic_mastery の整合 ---`);
  console.log(
    `  一致 ${matched} / 乖離 ${drifted} / 元帳に attempt が残っていない concept ${orphans.length}` +
      `（現行パラメータで再生した結果との比較）`,
  );
  if (orphans.length > 0) {
    console.log(
      `  孤児 concept（topic_mastery にあるが元帳ゼロ・attempts 保存値）: ` +
        orphans
          .slice(0, 5)
          .map((t) => `${t.concept_key}(${t.attempts})`)
          .join(", "),
    );
    console.log(
      "  ※ attempts>0 なのに元帳ゼロなら question 削除の cascade で attempt 行ごと消えた証拠。" +
        "この concept は replay で再計算できない",
    );
  }
  if (drifted > 0) {
    console.log("  乖離の例（concept / replay 値 attempts / 保存値 attempts）:");
    for (const d of driftExamples) {
      console.log(
        `    ${padEndWide(d.key, 34)} ${d.replayed.toFixed(3)} (${d.nR})  vs  ${d.stored.toFixed(3)} (${d.nS})`,
      );
    }
    console.log(
      "  ※ 乖離の切り分け（YAT-56 で 1 件を実際に追跡した手順）:\n" +
        "     - attempts 数がズレている → cascade 欠損（question 削除で attempt 行も消える）\n" +
        "     - attempts 数は一致するのに値がズレる → その concept の初回 attempt が YAT-28（EWMA 導入・\n" +
        "       2026-07-03 20:56 JST）より前で、topic_mastery に YAT-27 の素正答率が prev として\n" +
        "       残っている可能性。保存値から逆算して素正答率を初期値にすると一致することが多い\n" +
        "  ※ いずれの場合もパラメータ間の相対比較は同一元帳上で行うため、比較の妥当性は保たれる。\n" +
        "     元帳を正とするなら backfill で解消する（キャッシュを replay 値で上書きする）",
    );
  }

  // ── パラメータ候補の比較 ─────────────────────────────────────────────
  console.log(`\n--- パラメータ候補の比較（全 concept の mastery 分布）---`);
  console.log(
    `${padEndWide("候補", 22)} ${padStartWide("平均", 6)} ${padStartWide("中央", 6)} ${padStartWide("<0.3", 6)} ${padStartWide("≥0.7", 6)}`,
  );
  const results = CANDIDATES.map((c) => ({ ...c, acc: replay(attempts, c.params) }));
  for (const r of results) {
    const vals = [...r.acc.values()].map((v) => v.mastery).sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)] ?? 0;
    const weak = vals.filter((v) => v < 0.3).length;
    const strong = vals.filter((v) => v >= 0.7).length;
    console.log(
      `${padEndWide(r.name, 22)} ${padStartWide(mean(vals).toFixed(3), 6)} ${padStartWide(med.toFixed(3), 6)}` +
        ` ${padStartWide(String(weak), 6)} ${padStartWide(String(strong), 6)}`,
    );
  }

  // ── concept 別の軌跡（attempts の多い順）─────────────────────────────
  const ranked = [...base].sort((a, b) => b[1].n - a[1].n).slice(0, TOP_CONCEPTS);
  console.log(`\n--- concept 別の mastery（attempts 上位 ${ranked.length} 件）---`);
  console.log(
    `${padEndWide("concept", 34)} ${padStartWide("n", 4)} ` +
      CANDIDATES.map((c) => padStartWide(padEndWide(c.name, 8).trimEnd(), 9)).join(""),
  );
  for (const [key, r] of ranked) {
    const label = topicByKey.get(key)?.concept_label ?? key;
    const cells = results
      .map((res) => padStartWide((res.acc.get(key)?.mastery ?? 0).toFixed(3), 9))
      .join("");
    console.log(`${padEndWide(label, 34)} ${padStartWide(String(r.n), 4)} ${cells}`);
  }

  // ── カテゴリ別（buildCategoryMastery を再利用して本番と同じ集計にする）──────
  console.log(`\n--- カテゴリ別 mastery（現行パラメータで replay した値）---`);
  const conceptRows = [...base]
    .map(([key, r]) => {
      const t = topicByKey.get(key);
      if (!t) return null;
      return {
        concept_key: key,
        concept_label: t.concept_label,
        category: t.category,
        mastery: r.mastery,
        attempts: r.n,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  const cats = buildCategoryMastery(conceptRows);
  if (cats.length === 0) {
    console.log("  （topic_mastery に category を持つ concept が無いため集計不能）");
  }
  for (const c of cats) {
    console.log(
      `  ${padEndWide(c.label, 24)} mastery ${c.mastery.toFixed(3)} / concept ${c.conceptCount}` +
        `  弱点: ${c.weakest.map((w) => w.concept_label).join(", ") || "―"}`,
    );
  }

  console.log(
    `\n※ 書き戻しはしていない。パラメータを確定して topic_mastery を backfill するのは YAT-56 の範囲。`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
