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
import { padEndWide, padStartWide, pct } from "./_report-format";

// YAT-60: カード / クイズの dedup 閾値を較正するための診断スクリプト。
// CARD_DEDUP_THRESHOLD / QUIZ_DEDUP_THRESHOLD は記事用 DEDUP_THRESHOLD と同じ 0.86 のままで、
// 「別値に較正できるよう定義だけ分けてある」状態。較正しようにも両者の重複率を測る手段が無かった
// （compute-dedup-rate.ts は feed 単位の記事重複率しか出さず、この 2 定数に触れない）。
// 本番の dedup ループを再現し、閾値を振ったときに dup 判定がどう動くかを出す。
//
// card と quiz で再現方法が違う（ここを間違えると数字が狂う）:
// - card は dup 判定に関わらず population.push するので母集団が閾値に依存しない。各行の maxSim を
//   1 度だけ求めて閾値と比較すれば全閾値を一括判定できる。
// - quiz は dup を skip して population に積まない。閾値を変えると母集団自体がカスケードで変わる
//   ため、閾値ごとに累積ループを回し直さないと件数が過大に出る（A が B を弾けば B は母集団に
//   入らず、C は B と比較されない）。
//
// 読み取り専用。DB は一切書き換えない（compute-dedup-rate.ts は near_dup_rate を UPDATE するため
// 気軽に走らせられない。この診断は SELECT のみに徹する）。LLM 呼び出しも無いので課金は発生しない。
// 再較正に再利用できるよう committed utility として残す。

const SELECT_PAGE = 1000; // PostgREST 既定の 1 ページ上限。超える取得は .range() で回す
const THRESHOLDS = [0.8, 0.82, 0.84, 0.86, 0.88, 0.9, 0.92]; // スイープする閾値（tunable）
const HIST_BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]; // maxSim 分布のバケツ下限
const EXAMPLES = 5; // ダンプする高類似ペアの実例上限

// 本番の母集団更新の違い。閾値スイープの計算方法がこれで変わる。
type DedupMode = "keep-all" | "skip-dup";

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
  maxSims: number[]; // 各行の「自分より古い全行」に対する最大 cosine（分布表示用）
  sweep: { threshold: number; dup: number }[]; // 閾値ごとの dup 件数
  examples: { sim: number; a: string; b: string }[];
};

// 古い順に並べた embedding 列。本番の累積（候補 vs それまでの母集団）と順序を揃える。
function parseInOrder(rows: Row[]): { parsed: { vec: number[]; label: string }[]; failed: number } {
  const parsed: { vec: number[]; label: string }[] = [];
  let failed = 0;
  // 取得は created_at desc なので、累積を本番と揃えるため古い順に反転する。
  for (const r of [...rows].reverse()) {
    const vec = parseEmbedding(r.embedding);
    if (!vec) {
      failed += 1;
      continue;
    }
    parsed.push({ vec, label: r.label });
  }
  return { parsed, failed };
}

// 全行を母集団に積む前提での maxSim（card の挙動）。分布表示にも使う。
function computeMaxSims(parsed: { vec: number[]; label: string }[]): {
  maxSims: number[];
  dimMismatch: number;
  examples: { sim: number; a: string; b: string }[];
} {
  const maxSims: number[] = [];
  const examples: { sim: number; a: string; b: string }[] = [];
  let dimMismatch = 0;
  const lowest = Math.min(...THRESHOLDS);

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
    if (argmax >= 0 && maxSim >= lowest && examples.length < EXAMPLES) {
      examples.push({ sim: maxSim, a: parsed[i].label, b: parsed[argmax].label });
    }
  }
  return { maxSims, dimMismatch, examples };
}

// skip 方式（quiz）の閾値スイープ。dup を母集団に積まないので閾値ごとに累積を回し直す。
// keep-all（card）で使うと母集団が変わらないため maxSims との比較と一致する。
function sweepWithSkip(parsed: { vec: number[]; label: string }[], threshold: number): number {
  const population: number[][] = [];
  let skipped = 0;
  for (const cand of parsed) {
    let maxSim = 0;
    for (const p of population) {
      if (p.length !== cand.vec.length) continue;
      const sim = cosineSim(cand.vec, p);
      if (sim > maxSim) maxSim = sim;
    }
    if (maxSim >= threshold) skipped += 1;
    else population.push(cand.vec);
  }
  return skipped;
}

function analyze(rows: Row[], mode: DedupMode): Analysis {
  const { parsed, failed } = parseInOrder(rows);
  const { maxSims, dimMismatch, examples } = computeMaxSims(parsed);
  const sweep = THRESHOLDS.map((threshold) => ({
    threshold,
    dup:
      mode === "keep-all"
        ? maxSims.filter((s) => s >= threshold).length
        : sweepWithSkip(parsed, threshold),
  }));
  return {
    total: rows.length,
    withEmbedding: parsed.length,
    parseFailed: failed,
    dimMismatch,
    maxSims,
    sweep,
    examples,
  };
}

function report(title: string, a: Analysis, current: number, mode: DedupMode, note?: string) {
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

  const how =
    mode === "keep-all"
      ? "母集団は閾値に依存しない（dup も積む）"
      : "閾値ごとに累積を回し直した（dup は積まないので母集団がカスケードで変わる）";
  console.log(`\n  閾値スイープ（dup 判定される件数）— ${how}:`);
  for (const s of a.sweep) {
    const mark = Math.abs(s.threshold - current) < 1e-9 ? "  ← 現行" : "";
    console.log(
      `    ${s.threshold.toFixed(2)}  ${String(s.dup).padStart(5)} 件（${pct(s.dup, a.withEmbedding)}）${mark}`,
    );
  }

  console.log("\n  maxSim の分布（全行を母集団に積んだ場合の最近傍。分布把握用）:");
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
    `  中央値 ${p(0.5).toFixed(3)} / p90 ${p(0.9).toFixed(3)} / p99 ${p(0.99).toFixed(3)}` +
      ` / 最大 ${(sorted[sorted.length - 1] ?? 0).toFixed(3)}`,
  );

  if (a.examples.length > 0) {
    console.log("\n  --- 高類似ペアの実例 ---");
    for (const ex of a.examples) {
      console.log(`    [sim=${ex.sim.toFixed(3)}]`);
      console.log(`      新: ${padEndWide(ex.a, 76)}`);
      console.log(`      既: ${padEndWide(ex.b, 76)}`);
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
  report(
    "card_candidates（全 status）",
    analyze(cardRows, "keep-all"),
    CARD_DEDUP_THRESHOLD,
    "keep-all",
  );

  // status 別の内訳。承認 UI の効き方（YAT-27 で撤去済みなので現状は pending 一色のはず）が見える。
  const byStatus = new Map<string, number>();
  for (const r of cardRows) {
    const k = r.status ?? "(null)";
    byStatus.set(k, (byStatus.get(k) ?? 0) + 1);
  }
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
    analyze(quizActive, "skip-dup"),
    QUIZ_DEDUP_THRESHOLD,
    "skip-dup",
    "現存する問題は全て現行閾値 0.86 を通過済み（skip された問題は insert されず DB に無い）。" +
      "この母集団に対して閾値を振り直した結果なので、0.86 より上へ動かしたときに「本来通っていた" +
      "はずの問題」は復元できない。",
  );

  const quizAll = quizRaw.map(toQuizRow);
  if (quizAll.length !== quizActive.length) {
    report(
      "quiz_questions（全 status・retired 含む）",
      analyze(quizAll, "skip-dup"),
      QUIZ_DEDUP_THRESHOLD,
      "skip-dup",
      "retire 運用の影響を見るための参考値。本番の dedup 母集団ではない。",
    );
  }

  console.log(
    `\n現行値: CARD_DEDUP_THRESHOLD=${CARD_DEDUP_THRESHOLD} / QUIZ_DEDUP_THRESHOLD=${QUIZ_DEDUP_THRESHOLD}`,
  );
  console.log(
    padStartWide("", 0) +
      "※ card と quiz で母集団の扱いが違うため、同じ閾値でも件数の意味が異なる（上の注記を参照）",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
