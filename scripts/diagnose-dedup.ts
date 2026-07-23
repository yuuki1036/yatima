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
// YAT-61 以降、card / quiz とも dup 判定に関わらず population.push する（keep-all）。母集団が閾値に
// 依存しないので、各行の maxSim を 1 度だけ求めて閾値と比較すれば全閾値を一括判定できる。
// 旧 quiz は dup を skip して population に積まなかったため、閾値ごとに累積ループを回し直さないと
// 件数が過大に出た（A が B を弾けば B は母集団に入らず、C は B と比較されない）。その分岐は
// 両テーブルが keep-all になった時点で不要になったので削除した。skip 方式のゲートを再び診断する
// ことになったら、閾値ごとに累積を回し直す実装が要る点だけ覚えておくこと。
//
// 読み取り専用。DB は一切書き換えない（compute-dedup-rate.ts は near_dup_rate を UPDATE するため
// 気軽に走らせられない。この診断は SELECT のみに徹する）。LLM 呼び出しも無いので課金は発生しない。
// 再較正に再利用できるよう committed utility として残す。

const SELECT_PAGE = 1000; // PostgREST 既定の 1 ページ上限。超える取得は .range() で回す
const THRESHOLDS = [0.8, 0.82, 0.84, 0.86, 0.88, 0.9, 0.92]; // スイープする閾値（tunable）
const HIST_BUCKETS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]; // maxSim 分布のバケツ下限
const EXAMPLES = 5; // ダンプする高類似ペアの実例上限
const PAIR_DUMP_LIMIT = 40; // --pairs で列挙するペアの上限

// `--pairs <lo> <hi>` で類似度帯を指定すると、その帯に入る全ペアを類似度降順で列挙する。
// 閾値を決めるには「この帯のペアが本当に重複か」を人が見る必要があり、maxSim の実例 5 件では
// 判断材料が足りない（YAT-56 の較正作業で追加）。
function parsePairBand(): { lo: number; hi: number } | null {
  const i = process.argv.indexOf("--pairs");
  if (i < 0) {
    // 形式ミス（--pairs=0.8 等）を黙って無視すると「該当ペアなし」と誤解される。
    const unknown = process.argv.slice(2).filter((a) => a.startsWith("-"));
    if (unknown.length > 0) {
      console.error(`未知の引数: ${unknown.join(" ")}`);
      console.error("使い方: npm run diagnose-dedup -- --pairs <lo> <hi>  例: --pairs 0.86 0.9");
      process.exit(1);
    }
    return null;
  }
  const lo = Number(process.argv[i + 1]);
  const hi = Number(process.argv[i + 2]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
    console.error("使い方: npm run diagnose-dedup -- --pairs <lo> <hi>  例: --pairs 0.78 0.95");
    process.exit(1);
  }
  return { lo, hi };
}

const PAIR_BAND = parsePairBand();

type Parsed = { vec: number[]; label: string; source: string | null };

type Row = {
  id: string;
  created_at: string;
  embedding: unknown;
  status?: string | null;
  dup_flag?: boolean | null;
  dup_similarity?: number | null;
  label: string; // 実例ダンプ用の短い識別テキスト
  source: string | null; // 由来（card は article_id / quiz は source_ref）。同一ソース内かの判定用
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
  bandPairs: { sim: number; a: string; b: string; sameSource: boolean }[]; // --pairs 指定時のみ
  // 同一ソース由来（同じ記事から生成された兄弟）と、ソース跨ぎのペアを閾値ごとに分けた件数。
  // dedup が「重複した設問」ではなく「同じ記事の別観点」を弾いていないかを見る。
  sourceSplit: { threshold: number; same: number; cross: number; unknown: number }[];
  sourceNullRows: number; // source が null の行数（多いと分割の解釈が成立しない）
};

// 全ペアを走査して、閾値ごとに「同一ソース内」「ソース跨ぎ」の件数を数える。
// 全ペアの cosine を 1 度だけ計算し、閾値ごとのバケツに振る。閾値ごとに再計算すると
// THRESHOLDS の数だけ N² が増える（母集団が伸びたときに効く）。
// source が片方でも null のペアは「跨ぎ」ではなく unknown に分ける。null を跨ぎに混ぜると
// 「別記事の重複を拾っている」と正反対に読める出力になる。
function splitBySource(
  parsed: Parsed[],
): { threshold: number; same: number; cross: number; unknown: number }[] {
  const acc = THRESHOLDS.map((threshold) => ({ threshold, same: 0, cross: 0, unknown: 0 }));
  for (let i = 0; i < parsed.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (parsed[i].vec.length !== parsed[j].vec.length) continue;
      const sim = cosineSim(parsed[i].vec, parsed[j].vec);
      const si = parsed[i].source;
      const sj = parsed[j].source;
      const kind = si === null || sj === null ? "unknown" : si === sj ? "same" : "cross";
      for (const bucket of acc) {
        if (sim >= bucket.threshold) bucket[kind] += 1;
      }
    }
  }
  return acc;
}

// 指定した類似度帯に入る全ペアを類似度降順で返す（--pairs 用）。maxSim と違い「各行の最近傍」に
// 限らないので、同一記事から作られた設問群のように 3 件以上が互いに似ているケースも見える。
function pairsInBand(
  parsed: Parsed[],
  band: { lo: number; hi: number },
): { sim: number; a: string; b: string; sameSource: boolean }[] {
  const out: { sim: number; a: string; b: string; sameSource: boolean }[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (parsed[i].vec.length !== parsed[j].vec.length) continue;
      const sim = cosineSim(parsed[i].vec, parsed[j].vec);
      if (sim >= band.lo && sim <= band.hi) {
        const si = parsed[i].source;
        const sj = parsed[j].source;
        out.push({
          sim,
          a: parsed[i].label,
          b: parsed[j].label,
          sameSource: si !== null && sj !== null && si === sj,
        });
      }
    }
  }
  return out.sort((x, y) => y.sim - x.sim);
}

// 古い順に並べた embedding 列。本番の累積（候補 vs それまでの母集団）と順序を揃える。
function parseInOrder(rows: Row[]): { parsed: Parsed[]; failed: number } {
  const parsed: Parsed[] = [];
  let failed = 0;
  // 取得は created_at desc なので、累積を本番と揃えるため古い順に反転する。
  for (const r of [...rows].reverse()) {
    const vec = parseEmbedding(r.embedding);
    if (!vec) {
      failed += 1;
      continue;
    }
    parsed.push({ vec, label: r.label, source: r.source });
  }
  return { parsed, failed };
}

// 全行を母集団に積む前提での maxSim（card の挙動）。分布表示にも使う。
function computeMaxSims(parsed: Parsed[]): {
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

function analyze(rows: Row[]): Analysis {
  const { parsed, failed } = parseInOrder(rows);
  const { maxSims, dimMismatch, examples } = computeMaxSims(parsed);
  const sweep = THRESHOLDS.map((threshold) => ({
    threshold,
    dup: maxSims.filter((s) => s >= threshold).length,
  }));
  return {
    total: rows.length,
    withEmbedding: parsed.length,
    parseFailed: failed,
    dimMismatch,
    maxSims,
    sweep,
    examples,
    bandPairs: PAIR_BAND ? pairsInBand(parsed, PAIR_BAND) : [],
    sourceSplit: splitBySource(parsed),
    sourceNullRows: parsed.filter((p) => p.source === null).length,
  };
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

  console.log(
    "\n  閾値スイープ（dup 判定される件数）— 母集団は閾値に依存しない（dup も積む）:",
  );
  for (const s of a.sweep) {
    const mark = Math.abs(s.threshold - current) < 1e-9 ? "  ← 現行" : "";
    console.log(
      `    ${s.threshold.toFixed(2)}  ${String(s.dup).padStart(5)} 件（${pct(s.dup, a.withEmbedding)}）${mark}`,
    );
  }

  {
    // dedup が「重複した設問」を弾いているのか「同じ素材から作られた別観点」を弾いているのかを
    // 分ける。後者が支配的なら、閾値の上下では解決しない構造の問題。
    console.log("\n  閾値以上のペアの内訳（同一ソース内 / ソース跨ぎ / ソース不明）:");
    if (a.sourceNullRows > 0) {
      console.log(
        `    ⚠ source が null の行が ${a.sourceNullRows}/${a.withEmbedding} 件。` +
          `その行を含むペアは「不明」に計上され、同一/跨ぎの比率は当てにならない`,
      );
    }
    for (const s of a.sourceSplit) {
      const total = s.same + s.cross + s.unknown;
      const mark = Math.abs(s.threshold - current) < 1e-9 ? "  ← 現行" : "";
      console.log(
        `    ${s.threshold.toFixed(2)}  同一 ${String(s.same).padStart(4)}` +
          ` / 跨ぎ ${String(s.cross).padStart(4)}` +
          ` / 不明 ${String(s.unknown).padStart(4)}` +
          `（同一が ${pct(s.same, total)}）${mark}`,
      );
    }
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

  if (PAIR_BAND) {
    // 閾値を決めるための目視用。各ペアが「真の重複」か「同一記事の別観点」かを人が判定する。
    const shown = a.bandPairs.slice(0, PAIR_DUMP_LIMIT);
    console.log(
      `\n  --- 類似度 ${PAIR_BAND.lo}〜${PAIR_BAND.hi}（両端含む）のペア（全 ${a.bandPairs.length} 組` +
        `${a.bandPairs.length > shown.length ? `・上位 ${shown.length} 組を表示` : ""}）---`,
    );
    for (const p of shown) {
      console.log(`    [sim=${p.sim.toFixed(3)} ${p.sameSource ? "同一ソース" : "ソース跨ぎ"}]`);
      console.log(`      A: ${p.a.replace(/\s+/g, " ").slice(0, 110)}`);
      console.log(`      B: ${p.b.replace(/\s+/g, " ").slice(0, 110)}`);
    }
    if (a.bandPairs.length > shown.length) {
      console.log(`    …残り ${a.bandPairs.length - shown.length} 組は非表示`);
    }
    return;
  }

  if (a.examples.length > 0) {
    console.log("\n  --- 高類似ペアの実例 ---");
    for (const ex of a.examples) {
      console.log(`    [sim=${ex.sim.toFixed(3)}]`);
      console.log(`      新: ${padEndWide(ex.a, 76)}`);
      console.log(`      既: ${padEndWide(ex.b, 76)}`);
    }
  }
}

// insert 時に記録された dup_flag / dup_similarity の報告（YAT-61 で card / quiz 共通化）。
// **ゲートに弾かれた候補（dup_flag=true）を含む唯一のデータ**で、現存プールの再計算では代用できない
// （再計算は通過した側しか見ないため）。閾値の妥当性は「弾いた候補を見て、捨てすぎ / 残しすぎを
// 判断する」以外に測る方法が無い。
//
// 再計算 maxSim との違いに注意: dup_similarity は insert 当時の母集団に対する値で、母集団は時間と
// 共に増えるため、古い行ほど「当時は非 dup だったが今なら dup」になりうる。閾値を動かしたときに
// **その時点で何件が dup 側へ移るか**を測れるのは保存値のほうなので、両方を出す。
function reportStoredDup(rows: Row[], threshold: number) {
  const flagged = rows.filter((r) => r.dup_flag === true).length;
  const sims = rows
    .map((r) => r.dup_similarity)
    .filter((v): v is number => typeof v === "number");

  console.log(
    `\n  dup_flag=true（ゲートが近重複と判定した行）: ${flagged} 件` +
      `（全 ${rows.length} 行中 ${pct(flagged, rows.length)}）`,
  );
  if (sims.length === 0) {
    // card は 0007 の時点から dup_similarity を持つため、ここに来るのは生成が止まっている等が原因。
    // quiz は YAT-61 より前に積まれた行が該当する。テーブル非依存の言い方に留める。
    console.log(
      "    dup_similarity を持つ行が無い（この列が埋まるようになる前に積まれた行だけの状態）。" +
        "弾かれた候補の標本はまだ 0 件で、較正は新しい生成が貯まってから",
    );
    return;
  }
  const storedDup = sims.filter((s) => s >= threshold).length;
  console.log(
    `  保存済み dup_similarity: ${sims.length} 件中 ${storedDup} 件が現行閾値超え` +
      `（insert 当時の母集団に対する値）`,
  );
  // 保存値での閾値スイープ。「閾値をこう動かしたら、実際に弾かれた/通った件数がどう変わったか」を
  // 現存プールの再計算ではなく当時の判定値で測る（較正はこちらを見る）。
  console.log("    保存値での閾値スイープ（その閾値なら dup 判定だった件数）:");
  for (const t of THRESHOLDS) {
    const n = sims.filter((s) => s >= t).length;
    const mark = Math.abs(t - threshold) < 1e-9 ? "  ← 現行" : "";
    console.log(
      `      ${t.toFixed(2)}  ${String(n).padStart(5)} 件（${pct(n, sims.length)}）${mark}`,
    );
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
    "id, created_at, embedding, status, dup_flag, dup_similarity, article_id, type, front, back, cloze_text",
  );
  const cardRows: Row[] = cardRaw.map((r) => ({
    id: r.id as string,
    created_at: r.created_at as string,
    embedding: r.embedding,
    status: r.status as string | null,
    dup_flag: r.dup_flag as boolean | null,
    dup_similarity: r.dup_similarity as number | null,
    label:
      (r.type === "cloze" ? (r.cloze_text as string) : (r.front as string)) ??
      (r.back as string) ??
      "(空)",
    source: (r.article_id as string | null) ?? null,
  }));
  report(
    "card_candidates（全 status）",
    analyze(cardRows),
    CARD_DEDUP_THRESHOLD,
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

  reportStoredDup(cardRows, CARD_DEDUP_THRESHOLD);

  // ── quiz_questions ───────────────────────────────────────────────
  // 本番の母集団は status='active' かつ embedding 非 null（quiz-gate の loadQuizDedupPopulation）。
  // dup_flag=true の行も母集団に入る（YAT-61 の keep-all）ので、ここでも除外しない。
  const quizRaw = await selectAllRows(
    supabase,
    "quiz_questions",
    "id, created_at, embedding, status, dup_flag, dup_similarity, source_ref, stem",
  );
  const toQuizRow = (r: Record<string, unknown>): Row => ({
    id: r.id as string,
    created_at: r.created_at as string,
    embedding: r.embedding,
    status: r.status as string | null,
    dup_flag: r.dup_flag as boolean | null,
    dup_similarity: r.dup_similarity as number | null,
    label: (r.stem as string) ?? "(空)",
    source: (r.source_ref as string | null) ?? null,
  });
  const quizActive = quizRaw.filter((r) => r.status === "active").map(toQuizRow);
  report(
    "quiz_questions（status=active・本番の母集団）",
    analyze(quizActive),
    QUIZ_DEDUP_THRESHOLD,
    "YAT-61 で dup_flag 方式へ移行済み（近重複も insert され、出題時に dup_flag=false で絞る）。" +
      "ただし移行前に積まれた行は skip 方式の生き残りで dup_similarity を持たない。" +
      "この再計算スイープは現存プールの構造を見るためのもので、閾値較正には下の「保存済み" +
      "dup_similarity」を使うこと（弾いた候補が含まれるのはそちらだけ）。",
  );
  reportStoredDup(quizActive, QUIZ_DEDUP_THRESHOLD);

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
  console.log(
    padStartWide("", 0) +
      "※ 較正は「保存済み dup_similarity」のスイープを見ること。再計算スイープは現存プールに対する" +
      "もので、ゲートが弾いた候補（dup_flag=true）も含めた判断は保存値でしかできない",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
