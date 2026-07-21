import { config } from "dotenv";

// ローカル実行用に .env.local を読む。GitHub Actions では secrets が process.env にあり no-op。
config({ path: ".env.local" });

import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "../lib/supabase/admin";
import {
  parseEmbedding,
  cosineSim,
  CARD_DEDUP_THRESHOLD,
  QUIZ_DEDUP_THRESHOLD,
} from "../lib/ranking/dedup";

// YAT-60: カード / クイズの dedup 閾値を較正するための診断スクリプト。
// CARD_DEDUP_THRESHOLD / QUIZ_DEDUP_THRESHOLD は記事用 DEDUP_THRESHOLD と同じ 0.86 のままで、
// 「別値に較正できるよう定義だけ分けてある」状態。較正しようにも両者の重複率を測る手段が無かった
// （compute-dedup-rate.ts は feed 単位の記事重複率しか出さず、この 2 定数に触れない）。
// 本番の dedup ループ（card-gate / quiz-pool の「候補 vs それまでの母集団」の累積比較）を再現し、
// 閾値を振ったときに dup 判定がどう動くかを出す。当てずっぽうで閾値を触らないための観測。
//
// 読み取り専用。DB は一切書き換えない（compute-dedup-rate.ts は near_dup_rate を UPDATE するため
// 気軽に走らせられない。この診断は SELECT のみに徹する）。LLM 呼び出しも無いので課金は発生しない。
// 再較正に再利用できるよう committed utility として残す。

const SELECT_PAGE = 1000; // PostgREST 既定の 1 ページ上限。超える取得は .range() で回す
const THRESHOLDS = [0.8, 0.82, 0.84, 0.86, 0.88, 0.9, 0.92]; // スイープする閾値（tunable）
const HIST_BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]; // maxSim 分布のバケツ下限
const EXAMPLES = 5; // ダンプする高類似ペアの実例上限

type Row = {
  id: string;
  created_at: string;
  embedding: unknown;
  status?: string | null;
  dup_similarity?: number | null;
  label: string; // 実例ダンプ用の短い識別テキスト
};

// 1 テーブルを .range() で全件ページ取得する。created_at desc だけでは同一 created_at で
// ページ境界の取りこぼし/重複が起きるため、id asc を二次キーにして全順序にする
// （card-gate の selectAllCardColumn / quiz-pool の loadQuizDedupPopulation と同じ作法）。
// これを外すと母集団が 1000 行で頭打ちになり、診断結果そのものが嘘になる。
async function selectAllRows(
  supabase: SupabaseClient,
  table: string,
  columns: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += SELECT_PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true })
      .range(from, from + SELECT_PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...batch);
    if (batch.length < SELECT_PAGE) break;
  }
  return out;
}

type Analysis = {
  total: number; // 取得した行数
  withEmbedding: number; // embedding をパースできた行数
  parseFailed: number; // embedding が null / パース失敗の行数
  dimMismatch: number; // 次元が食い違って比較できなかったペアを持つ行数
  maxSims: number[]; // 各行の「自分より古い全行」に対する最大 cosine
  examples: { sim: number; a: string; b: string }[]; // 高類似ペアの実例
};

// 本番の dedup を再現する。card-gate / quiz-pool はどちらも「候補 1 件 vs それまでに積んだ母集団」
// を比較して population.push する累積ループなので、古い順に舐めて同じ形にする。
// 各行の maxSim を 1 度だけ求めておけば、閾値スイープは maxSim との比較だけで済む
// （閾値ごとに N² を回し直す必要が無い）。
function analyze(rows: Row[]): Analysis {
  const parsed: { vec: number[]; label: string }[] = [];
  let parseFailed = 0;
  // 取得は created_at desc なので、累積を本番と揃えるため古い順に反転する。
  for (const r of [...rows].reverse()) {
    const vec = parseEmbedding(r.embedding);
    if (!vec) {
      parseFailed += 1;
      continue;
    }
    parsed.push({ vec, label: r.label });
  }

  const maxSims: number[] = [];
  const examples: { sim: number; a: string; b: string }[] = [];
  let dimMismatch = 0;

  for (let i = 0; i < parsed.length; i += 1) {
    let maxSim = 0;
    let argmax = -1;
    let mismatched = false;
    for (let j = 0; j < i; j += 1) {
      if (parsed[i].vec.length !== parsed[j].vec.length) {
        // cosineSim は次元不一致で無言に 0 を返す。診断では黙って混ぜず数える。
        mismatched = true;
        continue;
      }
      const sim = cosineSim(parsed[i].vec, parsed[j].vec);
      if (sim > maxSim) {
        maxSim = sim;
        argmax = j;
      }
    }
    if (mismatched) dimMismatch += 1;
    // i=0 は比較対象が無く maxSim=0。母集団が空のときの本番挙動（非 dup）と同じ。
    maxSims.push(maxSim);
    if (argmax >= 0 && maxSim >= Math.min(...THRESHOLDS) && examples.length < EXAMPLES) {
      examples.push({ sim: maxSim, a: parsed[i].label, b: parsed[argmax].label });
    }
  }

  return {
    total: rows.length,
    withEmbedding: parsed.length,
    parseFailed,
    dimMismatch,
    maxSims,
    examples,
  };
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "―";
}

function report(title: string, a: Analysis, current: number, note?: string) {
  console.log(`\n=== ${title} ===`);
  console.log(
    `行数 ${a.total} / embedding 有り ${a.withEmbedding}（${pct(a.withEmbedding, a.total)}）` +
      ` / embedding 無し・パース失敗 ${a.parseFailed}`,
  );
  if (a.dimMismatch > 0) {
    console.log(`  ⚠ 次元不一致で比較を飛ばした行: ${a.dimMismatch}`);
  }
  if (note) console.log(`  ※ ${note}`);
  if (a.withEmbedding === 0) {
    console.log("  embedding を持つ行が無いため判定不能");
    return;
  }

  console.log("\n  閾値スイープ（dup 判定される件数）:");
  for (const t of THRESHOLDS) {
    const dup = a.maxSims.filter((s) => s >= t).length;
    const mark = Math.abs(t - current) < 1e-9 ? "  ← 現行" : "";
    console.log(
      `    ${t.toFixed(2)}  ${String(dup).padStart(5)} 件（${pct(dup, a.withEmbedding)}）${mark}`,
    );
  }

  console.log("\n  maxSim の分布:");
  const sorted = [...a.maxSims].sort((x, y) => x - y);
  for (let i = HIST_BUCKETS.length - 1; i >= 0; i -= 1) {
    const lo = HIST_BUCKETS[i];
    const hi = HIST_BUCKETS[i + 1];
    const n = a.maxSims.filter((s) => s >= lo && (hi === undefined || s < hi)).length;
    const range = hi === undefined ? `${lo.toFixed(2)}〜` : `${lo.toFixed(2)}〜${hi.toFixed(2)}`;
    console.log(`    ${range.padEnd(12)} ${String(n).padStart(5)} 件`);
  }
  const below = a.maxSims.filter((s) => s < HIST_BUCKETS[0]).length;
  console.log(`    〜${HIST_BUCKETS[0].toFixed(2)}       ${String(below).padStart(5)} 件`);
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  console.log(
    `  中央値 ${p(0.5).toFixed(3)} / p90 ${p(0.9).toFixed(3)} / p99 ${p(0.99).toFixed(3)} / 最大 ${(sorted[sorted.length - 1] ?? 0).toFixed(3)}`,
  );

  if (a.examples.length > 0) {
    console.log("\n  --- 高類似ペアの実例 ---");
    for (const ex of a.examples) {
      console.log(`    [sim=${ex.sim.toFixed(3)}]`);
      console.log(`      新: ${ex.a.slice(0, 80)}`);
      console.log(`      既: ${ex.b.slice(0, 80)}`);
    }
  }
}

async function main() {
  const supabase = createAdminClient();

  // ── card_candidates ──────────────────────────────────────────────
  // 本番の母集団は全 status（card-gate の selectAllCardColumn はフィルタ無し）。dup 判定された行も
  // insert されるため survivorship bias が無く、実際に起きた dedup を忠実に再現できる。
  const cardRaw = await selectAllRows(
    supabase,
    "card_candidates",
    "id, created_at, embedding, status, dup_similarity, type, front, back, cloze_text",
  );
  const cardRows: Row[] = cardRaw.map((r) => ({
    id: r.id as string,
    created_at: r.created_at as string,
    embedding: r.embedding,
    status: r.status as string | null,
    dup_similarity: r.dup_similarity as number | null,
    label:
      (r.type === "cloze" ? (r.cloze_text as string) : (r.front as string)) ??
      (r.back as string) ??
      "(空)",
  }));
  report("card_candidates（全 status）", analyze(cardRows), CARD_DEDUP_THRESHOLD);

  // status 別の内訳。承認 UI の効き方（YAT-27 で撤去済みなので現状は pending 一色のはず）が見える。
  const byStatus = new Map<string, number>();
  for (const r of cardRows) byStatus.set(r.status ?? "(null)", (byStatus.get(r.status ?? "(null)") ?? 0) + 1);
  console.log(
    `\n  status 内訳: ${[...byStatus].map(([s, n]) => `${s}=${n}`).join(" / ") || "(行なし)"}`,
  );

  // insert 時点で保存された dup_similarity と、現在の母集団での再計算値のズレ。母集団は時間と共に
  // 増えるため、古い行ほど「当時は非 dup だったが今なら dup」になりうる。
  const storedSims = cardRows
    .map((r) => r.dup_similarity)
    .filter((v): v is number => typeof v === "number");
  if (storedSims.length > 0) {
    const storedDup = storedSims.filter((s) => s >= CARD_DEDUP_THRESHOLD).length;
    console.log(
      `  保存済み dup_similarity: ${storedSims.length} 件中 ${storedDup} 件が現行閾値超え` +
        `（insert 当時の母集団に対する値）`,
    );
  }

  // ── quiz_questions ───────────────────────────────────────────────
  // 本番の母集団は status='active' かつ embedding 非 null（quiz-pool の loadQuizDedupPopulation）。
  const quizRaw = await selectAllRows(
    supabase,
    "quiz_questions",
    "id, created_at, embedding, status, stem",
  );
  const toQuizRow = (r: Record<string, unknown>): Row => ({
    id: r.id as string,
    created_at: r.created_at as string,
    embedding: r.embedding,
    status: r.status as string | null,
    label: (r.stem as string) ?? "(空)",
  });
  const quizActive = quizRaw.filter((r) => r.status === "active").map(toQuizRow);
  report(
    "quiz_questions（status=active・本番の母集団）",
    analyze(quizActive),
    QUIZ_DEDUP_THRESHOLD,
    "quiz は dup をその場で skip して insert しないため survivorship bias がある。" +
      "閾値を下げたときの追加 dup は測れるが、上げたときに「本来通っていたはずの問題」は復元できない。",
  );

  const quizAll = quizRaw.map(toQuizRow);
  if (quizAll.length !== quizActive.length) {
    report(
      "quiz_questions（全 status・retired 含む）",
      analyze(quizAll),
      QUIZ_DEDUP_THRESHOLD,
      "retire 運用の影響を見るための参考値。本番の dedup 母集団ではない。",
    );
  }

  console.log(
    `\n現行値: CARD_DEDUP_THRESHOLD=${CARD_DEDUP_THRESHOLD} / QUIZ_DEDUP_THRESHOLD=${QUIZ_DEDUP_THRESHOLD}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
