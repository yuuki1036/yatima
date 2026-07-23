import { describe, it, expect } from "vitest";
import {
  shuffleChoices,
  choiceShuffleSeed,
  markQuizDuplicates,
  type QuizInsertRow,
} from "@/lib/learn/quiz-gate";
import { QUIZ_DEDUP_THRESHOLD } from "@/lib/ranking/dedup";

// YAT-62: LLM は正解を choices[0] に置きがちなので、insert 前に決定的シャッフルで位置を一様化する。
// 実使用で「選択肢 1 つ目が答えであることがほとんど」という報告が出た件の回帰ガード
// （原因はシャッフル導入前の旧データだったが、シャッフル自体が壊れていないことも固定しておく）。

// YAT-61: dedup は「近重複を insert しない」skip 方式から「insert して dup_flag を立てる」方式へ。
// skip 方式では弾いた候補が DB に残らず閾値較正の標本が原理的に取れなかったため
// （[[generated-sibling-dedup-threshold]]）、行が残ることを回帰ガードとして固定する。
describe("markQuizDuplicates", () => {
  const row = (stem: string): QuizInsertRow => ({
    concept_key: "api-design",
    concept_label: "API 設計",
    category: "tech/web",
    difficulty: "medium",
    stem,
    choices: ["a", "b", "c", "d"],
    answer_index: 0,
    explanation: "解説",
    source_quote: "引用",
    grounded: true,
    source_ref: "src-1",
    status: "active",
  });

  // 単位ベクトルの cosine は角度の cos そのものなので、狙った類似度をそのまま作れる。
  const unit = (rad: number) => [Math.cos(rad), Math.sin(rad)];
  const ANGLE_087 = Math.acos(0.87); // 閾値 0.86 をわずかに超える角度

  it("閾値超えでも行を捨てず dup_flag=true で積む（skip 方式との差）", () => {
    const r = markQuizDuplicates([row("Q1")], [unit(ANGLE_087)], [unit(0)]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].dup_flag).toBe(true);
    expect(r.dupFlagged).toBe(1);
  });

  // embedding は optional なので、付け忘れても tsc が落ちない。壊れると全行が embedding=null で
  // insert され、以降 loadQuizDedupPopulation がその回の行を拾えず dedup が静かに無効化する
  // （YAT-56 で塞いだ穴の再発）。vecToPg の出力形式ごと固定して pgvector 側の回帰も一緒に守る。
  it("embed 成功行には vecToPg 済みの embedding が付く", () => {
    const r = markQuizDuplicates([row("Q1")], [[1, 0]], []);
    expect(r.rows[0].embedding).toBe("[1,0]");
  });

  it("dup_similarity に生の maxSim を残す（閾値を動かしたときの件数を後から数え直せる）", () => {
    const r = markQuizDuplicates([row("Q1")], [unit(ANGLE_087)], [unit(0)]);
    expect(r.rows[0].dup_similarity).toBeCloseTo(0.87, 5);
  });

  it("閾値未満は dup_flag=false（出題プールに乗る）", () => {
    const r = markQuizDuplicates([row("Q1")], [unit(Math.acos(0.5))], [unit(0)]);
    expect(r.rows[0].dup_flag).toBe(false);
    expect(r.rows[0].dup_similarity).toBeCloseTo(0.5, 5);
    expect(r.dupFlagged).toBe(0);
  });

  it("母集団が空なら最初の候補は非 dup（maxSim=0）", () => {
    const r = markQuizDuplicates([row("Q1")], [unit(0)], []);
    expect(r.rows[0].dup_flag).toBe(false);
    expect(r.rows[0].dup_similarity).toBe(0);
  });

  it("dup 判定された候補も母集団に積む（keep-all。積まないと閾値でカスケードが変わる）", () => {
    // A(0°) → B(29.5°) は 0.87 で dup、C(59.1°) は A とは 0.51 だが B とは 0.87。
    // B を積んでいれば C も dup になる＝dup も母集団に入っている証拠。
    const r = markQuizDuplicates(
      [row("B"), row("C")],
      [unit(ANGLE_087), unit(ANGLE_087 * 2)],
      [unit(0)],
    );
    expect(r.rows.map((x) => x.dup_flag)).toEqual([true, true]);
    expect(r.rows[1].dup_similarity).toBeCloseTo(0.87, 5);
    expect(r.dupFlagged).toBe(2);
  });

  it("embed 失敗（vec=null）は embedding=null・dup 未判定で積む", () => {
    const r = markQuizDuplicates([row("Q1")], [null], [unit(0)]);
    expect(r.embedFailed).toBe(1);
    expect(r.rows[0].embedding).toBeNull();
    expect(r.rows[0].dup_flag).toBe(false);
    expect(r.rows[0].dup_similarity).toBeNull();
    // dupFlagged を汚さない（汚すと cron ログの「うち出題可」が狂い、較正の判断材料がずれる）。
    expect(r.dupFlagged).toBe(0);
  });

  // 次元不一致は cosineSim も 0 を返すため、実装側の continue の有無で結果は変わらない
  // （continue を消してもこのテストは通る＝ガードの回帰ガードではない）。ここで固定しているのは
  // 「次元が違う相手は dup 判定に効かない」という結果側の性質。
  it("次元が食い違う母集団は dup 判定に効かない（dup_similarity=0）", () => {
    const r = markQuizDuplicates([row("Q1")], [[1, 0]], [[1, 0, 0]]);
    expect(r.rows[0].dup_flag).toBe(false);
    expect(r.rows[0].dup_similarity).toBe(0);
  });

  it("閾値ちょうどは dup 扱い（>= 比較。境界の回帰ガード）", () => {
    const r = markQuizDuplicates(
      [row("Q1")],
      [unit(Math.acos(QUIZ_DEDUP_THRESHOLD))],
      [unit(0)],
    );
    expect(r.rows[0].dup_flag).toBe(true);
  });
});

describe("choiceShuffleSeed", () => {
  it("同じ入力からは同じ seed（再現可能・移行 script が同じ並びを再現できる前提）", () => {
    expect(choiceShuffleSeed("api-design", "Q1 とは何か")).toBe(
      choiceShuffleSeed("api-design", "Q1 とは何か"),
    );
  });

  it("concept か stem が違えば seed も違う", () => {
    const base = choiceShuffleSeed("api-design", "Q1");
    expect(choiceShuffleSeed("api-design", "Q2")).not.toBe(base);
    expect(choiceShuffleSeed("other", "Q1")).not.toBe(base);
  });

  // 区切りは U+0000。実バイトの NUL をソースに置くと file(1) がバイナリ判定し grep -r が
  // 黙ってスキップするため、エスケープ表記で書いている。文字としては同一なので seed も同一。
  it("区切りは U+0000（実バイト NUL と同じ文字＝既存問題の seed が変わらない）", () => {
    const NUL = String.fromCharCode(0);
    // FNV-1a を直接計算した参照値と突き合わせる（実装の写しではなく仕様の再計算）。
    const fnv = (s: string) => {
      let h = 2166136261;
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    };
    expect(choiceShuffleSeed("c", "s")).toBe(fnv(`c${NUL}s`));
  });

  it("区切りがあるので連結の境界が違えば別 seed（'ab'+'c' と 'a'+'bc' が衝突しない）", () => {
    expect(choiceShuffleSeed("ab", "c")).not.toBe(choiceShuffleSeed("a", "bc"));
  });
});

describe("shuffleChoices", () => {
  const choices = ["正解", "誤り1", "誤り2", "誤り3"];

  it("正解のテキストが移動先でも保たれる", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const r = shuffleChoices(choices, 0, seed);
      expect(r.choices[r.answerIndex]).toBe("正解");
    }
  });

  it("選択肢の集合は変わらない（並べ替えのみ）", () => {
    const r = shuffleChoices(choices, 2, 12345);
    expect([...r.choices].sort()).toEqual([...choices].sort());
  });

  it("同じ seed なら同じ結果（決定的）", () => {
    const a = shuffleChoices(choices, 1, 999);
    const b = shuffleChoices(choices, 1, 999);
    expect(a).toEqual(b);
  });

  it("重複した選択肢があっても正解位置が一意に決まる", () => {
    // indexOf の最初一致に倒れると、重複がある場合に誤った位置を返しうる。
    // インデックス配列を並べ替えて写像を作っているので、正解として指定した要素が追跡される。
    const dup = ["同じ", "同じ", "別1", "別2"];
    for (let seed = 0; seed < 50; seed += 1) {
      const r = shuffleChoices(dup, 1, seed);
      expect(r.choices[r.answerIndex]).toBe("同じ");
      // 「同じ」は 2 つあるが、answerIndex は index=1 由来の 1 箇所だけを指す。
      expect(r.choices.filter((c) => c === "同じ")).toHaveLength(2);
    }
  });

  // これが本丸。LLM が常に 0 を正解にしても、保存される位置が偏らないことを固定する。
  it("正解が常に choices[0] でも、保存位置は 4 箇所へ十分ばらける", () => {
    const dist = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i += 1) {
      const r = shuffleChoices(choices, 0, choiceShuffleSeed(`c${i}`, `stem ${i}`));
      dist[r.answerIndex] += 1;
    }
    const expected = 4000 / 4;
    const chi = dist.reduce((s, o) => s + (o - expected) ** 2 / expected, 0);
    // 自由度 3 の χ² 上側 0.1% 点は 16.27。実装が偏っていれば遥かに超える
    // （シャッフル導入前の実データは χ²=89 だった）。
    expect(chi).toBeLessThan(16.27);
    for (const n of dist) expect(n).toBeGreaterThan(0);
  });
});
