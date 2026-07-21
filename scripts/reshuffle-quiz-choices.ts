import { config } from "dotenv";

// ローカル実行用に .env.local を読む（GitHub Actions では secrets が process.env にある）。
config({ path: ".env.local" });

import { createAdminClient } from "../lib/supabase/admin";
import { shuffleChoices, choiceShuffleSeed } from "../lib/learn/quiz-gate";

// YAT-62: 選択肢シャッフル導入（39c4991 / 2026-07-13）より前に生成された既存問題の
// answer_index 偏りを是正する一度きりの script。
//
// 背景: LLM は正解を choices[0] に置きがちで、シャッフル導入前の問題は答えの位置が極端に偏る。
// 実測（2026-07-21・全 71 問）:
//   導入前 53 問: [0,1,2,3] = 42, 11, 0, 0   ← index 2/3 が 1 件も無い
//   導入後 18 問: [0,1,2,3] =  4,  4, 5, 5   ← χ²=0.22 でほぼ一様
// シャッフル関数自体は正しく動いている（seed 40000 件で各 25% に収束することを確認済み）。
// 残っているのは旧データだけなので、生成し直さず既存行を並べ替えるだけで直る（LLM 課金なし）。
//
// 安全ガード:
// - 既定は dry-run（対象件数と変化の分布を表示するのみ）。実際に更新するには `--apply` を付ける。
// - 本番と同一の `shuffleChoices` / `choiceShuffleSeed` を import して使う。式を複製しない。
// - 決定的なので、同じ行に 2 回適用すると 2 回並べ替わる（冪等ではない）。二重実行を避けるため
//   `--before <ISO8601>` で対象を絞る運用にし、既定はシャッフル導入コミットの時刻を使う。
// - answer_index と choices は必ずセットで更新する（片方だけ書くと正解が壊れる）。
//
// 巻き戻し: 決定的ではあるが逆変換は用意していない。実行前に対象行を控えておくこと
//   select id, choices, answer_index from quiz_questions where created_at < '<cutoff>';
//
// 既知の副作用: quiz_attempts.chosen_index は「ユーザーが何番目を選んだか」の記録なので、
// 並べ替え後は当時の並びと対応しなくなる。正誤は is_correct に保存済みで mastery は元帳から
// replay できるため、学習データへの影響は無い（記録の整合だけの話）。

const APPLY = process.argv.includes("--apply");

// シャッフル導入コミット 39c4991（2026-07-13 08:31:17 +0900）の時刻。これより前に作られた行が対象。
const DEFAULT_CUTOFF = "2026-07-12T23:31:17Z";

function parseCutoff(): string {
  const i = process.argv.indexOf("--before");
  if (i < 0) return DEFAULT_CUTOFF;
  const v = process.argv[i + 1];
  if (!v || Number.isNaN(Date.parse(v))) {
    console.error("使い方: npm run reshuffle-quiz-choices -- --before <ISO8601> [--apply]");
    process.exit(1);
  }
  return new Date(v).toISOString();
}

type Row = {
  id: string;
  concept_key: string;
  stem: string;
  choices: unknown;
  answer_index: number;
};

async function main() {
  const supabase = createAdminClient();
  const cutoff = parseCutoff();

  const { data, error } = await supabase
    .from("quiz_questions")
    .select("id, concept_key, stem, choices, answer_index")
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("quiz_questions の取得に失敗:", error);
    process.exit(1);
  }
  const rows = (data ?? []) as unknown as Row[];

  console.log("=== 既存クイズの選択肢を再シャッフル（YAT-62） ===");
  console.log(`対象: created_at < ${cutoff} の ${rows.length} 件${APPLY ? "" : "（dry-run）"}`);
  if (rows.length === 0) {
    console.log("対象がありません（既に適用済みか、cutoff が古すぎる可能性）");
    return;
  }

  const before = [0, 0, 0, 0];
  const after = [0, 0, 0, 0];
  const updates: { id: string; choices: string[]; answer_index: number }[] = [];
  let malformed = 0;

  for (const r of rows) {
    // choices は jsonb 由来。想定外の形（長さ 4 でない・非文字列）は触らず飛ばす。
    if (!Array.isArray(r.choices) || r.choices.length !== 4 || !r.choices.every((c) => typeof c === "string")) {
      malformed += 1;
      continue;
    }
    if (r.answer_index < 0 || r.answer_index > 3) {
      malformed += 1;
      continue;
    }
    before[r.answer_index] += 1;
    const shuffled = shuffleChoices(
      r.choices as string[],
      r.answer_index,
      choiceShuffleSeed(r.concept_key, r.stem),
    );
    after[shuffled.answerIndex] += 1;
    updates.push({ id: r.id, choices: shuffled.choices, answer_index: shuffled.answerIndex });
  }

  const chi = (d: number[]) => {
    const n = d.reduce((s, x) => s + x, 0);
    if (n === 0) return 0;
    const e = n / 4;
    return d.reduce((s, o) => s + (o - e) ** 2 / e, 0);
  };
  console.log(`\n答えの位置の分布 [0,1,2,3]:`);
  console.log(`  変更前: ${before.join(", ")}  χ²=${chi(before).toFixed(2)}`);
  console.log(`  変更後: ${after.join(", ")}  χ²=${chi(after).toFixed(2)}（自由度3・一様なら概ね 7.8 未満）`);
  if (malformed > 0) {
    console.log(`  ⚠ 形式が想定外で対象外にした行: ${malformed}`);
  }

  if (!APPLY) {
    console.log(`\n--apply を付けると ${updates.length} 件を更新します`);
    return;
  }

  let ok = 0;
  for (const u of updates) {
    // choices と answer_index は必ずセットで更新する（片方だけだと正解が壊れる）。
    const { error: upErr } = await supabase
      .from("quiz_questions")
      .update({ choices: u.choices, answer_index: u.answer_index })
      .eq("id", u.id);
    if (upErr) {
      console.warn(`更新に失敗 [${u.id}]:`, upErr);
      continue;
    }
    ok += 1;
  }
  console.log(`\n更新完了: ${ok} / ${updates.length} 件`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
