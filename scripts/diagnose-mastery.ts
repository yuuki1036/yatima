import { config } from "dotenv";

// ローカル実行用に .env.local を読む。GitHub Actions では secrets が process.env にあり no-op。
config({ path: ".env.local" });

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../lib/supabase/admin";
import { nextMastery, buildCategoryMastery } from "../lib/learn/mastery";
import type { QuizDifficulty } from "../lib/types";

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
// 下の assertBaselineMatches が本物の nextMastery と突き合わせて写し間違いを検出する）。
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
function assertBaselineMatches() {
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
          console.error("mastery.ts の MASTERY_ALPHA が変わった可能性がある。CURRENT を更新すること。");
          process.exit(1);
        }
      }
    }
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
  assertBaselineMatches();

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
  console.log(`\n--- replay と topic_mastery の整合 ---`);
  console.log(`  一致 ${matched} / 乖離 ${drifted}（現行パラメータで再生した結果との比較）`);
  if (drifted > 0) {
    console.log("  乖離の例（concept / replay 値 attempts / 保存値 attempts）:");
    for (const d of driftExamples) {
      console.log(
        `    ${d.key.slice(0, 32).padEnd(34)} ${d.replayed.toFixed(3)} (${d.nR})  vs  ${d.stored.toFixed(3)} (${d.nS})`,
      );
    }
    console.log(
      "  ※ attempts 数がズレていれば cascade 欠損（question 削除で attempt 行も消える）の可能性。" +
        "パラメータ間の相対比較は同一元帳上で行うため、乖離があっても比較の妥当性は保たれる。",
    );
  }

  // ── パラメータ候補の比較 ─────────────────────────────────────────────
  console.log(`\n--- パラメータ候補の比較（全 concept の mastery 分布）---`);
  console.log(
    `${"候補".padEnd(22)} ${"平均".padStart(6)} ${"中央".padStart(6)} ${"<0.3".padStart(6)} ${"≥0.7".padStart(6)}`,
  );
  const results = CANDIDATES.map((c) => ({ ...c, acc: replay(attempts, c.params) }));
  for (const r of results) {
    const vals = [...r.acc.values()].map((v) => v.mastery).sort((a, b) => a - b);
    const med = vals[Math.floor(vals.length / 2)] ?? 0;
    const weak = vals.filter((v) => v < 0.3).length;
    const strong = vals.filter((v) => v >= 0.7).length;
    console.log(
      `${r.name.padEnd(22)} ${mean(vals).toFixed(3).padStart(6)} ${med.toFixed(3).padStart(6)}` +
        ` ${String(weak).padStart(6)} ${String(strong).padStart(6)}`,
    );
  }

  // ── concept 別の軌跡（attempts の多い順）─────────────────────────────
  const ranked = [...base].sort((a, b) => b[1].n - a[1].n).slice(0, TOP_CONCEPTS);
  console.log(`\n--- concept 別の mastery（attempts 上位 ${ranked.length} 件）---`);
  console.log(
    `${"concept".padEnd(34)} ${"n".padStart(4)} ` +
      CANDIDATES.map((c) => c.name.slice(0, 8).padStart(9)).join(""),
  );
  for (const [key, r] of ranked) {
    const label = topicByKey.get(key)?.concept_label ?? key;
    const cells = results
      .map((res) => (res.acc.get(key)?.mastery ?? 0).toFixed(3).padStart(9))
      .join("");
    console.log(`${label.slice(0, 33).padEnd(34)} ${String(r.n).padStart(4)} ${cells}`);
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
      `  ${c.label.padEnd(24)} mastery ${c.mastery.toFixed(3)} / concept ${c.conceptCount}` +
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
