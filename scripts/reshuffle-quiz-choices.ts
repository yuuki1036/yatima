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
// - **冪等ではない。** 決定的なので同じ行に 2 回適用すると置換 P が 2 回かかる（P²）。
//   `--before` は対象範囲を絞るだけで、二重実行のガードにはならない（UPDATE は choices と
//   answer_index しか書かず created_at は不変なので、何度実行しても同じ行集合が返る）。
//   retire-news-quiz が「適用後に条件が偽になる述語」で冪等を得ているのとは性質が違う。
//   二重適用してもデータは壊れない（choices と answer_index をセット更新するので正解は保たれる）が、
//   4 要素の置換 24 個のうち P²=恒等 になる involution が 10 個あるため、**約 42% の行が元の
//   偏った位置に戻る**＝直した分が無音で薄まる。再実行するなら未適用行だけに絞ること。
// - answer_index と choices は必ずセットで更新する（片方だけ書くと正解が壊れる）。
//
// 巻き戻し: seed 由来の列（concept_key / stem）を更新しないので、置換は**可逆**。
//   order = <choiceShuffleSeed から得た順列> として
//     original_answer_index = order[current_answer_index]
//     original_choices[order[k]] = current_choices[k]
//   で復元できる。dry-run は対象 id を出力するので、失敗ログと突き合わせて部分復旧もできる。
//   念のため実行前に控えるなら:
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

  // PostgREST の既定上限は 1000 行。range() で回さないと黙って切れ、「更新完了」だけが出て
  // 残りが未適用のまま気づけない（このリポジトリの他モジュールと同じ作法）。
  const SELECT_PAGE = 1000;
  const rows: Row[] = [];
  for (let from = 0; ; from += SELECT_PAGE) {
    const { data, error } = await supabase
      .from("quiz_questions")
      .select("id, concept_key, stem, choices, answer_index")
      .lt("created_at", cutoff)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }) // 同一 created_at でのページ境界の取りこぼしを防ぐ
      .range(from, from + SELECT_PAGE - 1);
    if (error) {
      console.error("quiz_questions の取得に失敗:", error);
      process.exit(1);
    }
    const batch = (data ?? []) as unknown as Row[];
    rows.push(...batch);
    if (batch.length < SELECT_PAGE) break;
  }

  console.log("=== 既存クイズの選択肢を再シャッフル（YAT-62） ===");
  console.log(`対象: created_at < ${cutoff} の ${rows.length} 件${APPLY ? "" : "（dry-run）"}`);
  if (rows.length === 0) {
    console.log("対象がありません（既に適用済みか、cutoff が古すぎる可能性）");
    return;
  }

  const before = [0, 0, 0, 0];
  const after = [0, 0, 0, 0];
  const updates: { id: string; choices: string[]; answer_index: number }[] = [];
  const malformedIds: string[] = [];

  for (const r of rows) {
    // choices は jsonb 由来。想定外の形（長さ 4 でない・非文字列）は触らず飛ばす。
    if (!Array.isArray(r.choices) || r.choices.length !== 4 || !r.choices.every((c) => typeof c === "string")) {
      malformedIds.push(r.id);
      continue;
    }
    if (r.answer_index < 0 || r.answer_index > 3) {
      malformedIds.push(r.id);
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
  if (malformedIds.length > 0) {
    console.log(`  ⚠ 形式が想定外で対象外にした行: ${malformedIds.length}`);
    console.log(`     ids: ${malformedIds.join(",")}`);
  }

  if (!APPLY) {
    console.log(`\n--apply を付けると ${updates.length} 件を更新します`);
    // 巻き戻し・部分復旧に使えるよう対象 id を出す（retire-news-quiz と同じ作法）。
    console.log(`対象 ids: ${updates.map((u) => u.id).join(",")}`);
    return;
  }

  let ok = 0;
  const failedIds: string[] = [];
  for (const u of updates) {
    // choices と answer_index は必ずセットで更新する（片方だけだと正解が壊れる）。
    const { error: upErr } = await supabase
      .from("quiz_questions")
      .update({ choices: u.choices, answer_index: u.answer_index })
      .eq("id", u.id);
    if (upErr) {
      console.warn(`更新に失敗 [${u.id}]:`, upErr);
      failedIds.push(u.id);
      continue;
    }
    ok += 1;
  }
  console.log(`\n更新完了: ${ok} / ${updates.length} 件`);
  if (failedIds.length > 0) {
    // 部分適用のまま exit 0 で返すと、呼び出し側（&& での連鎖や CI）が成功扱いする。
    // 再実行は成功済みの行を二重シャッフルするので、失敗 id を絞って対処すること。
    console.error(`失敗した ids: ${failedIds.join(",")}`);
    console.error("再実行は成功済みの行も再処理する。上記 id だけに絞って対処すること");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
