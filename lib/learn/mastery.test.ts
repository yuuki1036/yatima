import { describe, it, expect } from "vitest";
import {
  nextMastery,
  scoreQuestion,
  buildCategoryMastery,
} from "@/lib/learn/mastery";
import { tagLabel } from "@/lib/tags/vocabulary";
import type { QuizDifficulty, QuizQuestion } from "@/lib/types";

// YAT-53: mastery の pure ロジック（EWMA 更新式・出題スコア・弱点マップ集計）のユニットテスト。
// DB 依存の recordQuizAttempt / selectSessionQuestions / markConceptsServed は対象外（純ロジックのみ）。

const MS_PER_DAY = 86_400_000;
const NOW = Date.parse("2026-07-16T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * MS_PER_DAY).toISOString();

// jitter を無効化する rng（jitter = 1 + 0.1 * (0.5 - 0.5) = 1）。決定的アサート用。
const noJitter = () => 0.5;

describe("nextMastery", () => {
  // MASTERY_PRIOR = 0.3 を起点に、α の非対称（難問正解=大/易問不正解=大）を検証する。
  it("medium 正解は prev から 1 へ α=0.25 だけ寄る", () => {
    // 0.3 + 0.25 * (1 - 0.3) = 0.475
    expect(nextMastery(0.3, "medium", true)).toBeCloseTo(0.475);
  });

  it("medium 不正解は prev から 0 へ α=0.25 だけ寄る", () => {
    // 0.3 + 0.25 * (0 - 0.3) = 0.225
    expect(nextMastery(0.3, "medium", false)).toBeCloseTo(0.225);
  });

  it("難問正解は易問正解より大きく上がる（α: hard 0.4 > easy 0.15）", () => {
    const hard = nextMastery(0.3, "hard", true); // 0.3 + 0.4*0.7 = 0.58
    const easy = nextMastery(0.3, "easy", true); // 0.3 + 0.15*0.7 = 0.405
    expect(hard).toBeCloseTo(0.58);
    expect(easy).toBeCloseTo(0.405);
    expect(hard).toBeGreaterThan(easy);
  });

  it("易問不正解は難問不正解より大きく下がる（α: easy 0.4 > hard 0.15）", () => {
    const easy = nextMastery(0.3, "easy", false); // 0.3 - 0.4*0.3 = 0.18
    const hard = nextMastery(0.3, "hard", false); // 0.3 - 0.15*0.3 = 0.255
    expect(easy).toBeCloseTo(0.18);
    expect(hard).toBeCloseTo(0.255);
    expect(easy).toBeLessThan(hard);
  });

  it("正答を積むと prior(0.3) から単調に 1 へ近づく", () => {
    let m = 0.3;
    const seq = [m];
    for (let i = 0; i < 5; i++) {
      m = nextMastery(m, "medium", true);
      seq.push(m);
    }
    // 単調増加かつ 1 を超えない
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThan(seq[i - 1]);
      expect(seq[i]).toBeLessThanOrEqual(1);
    }
  });

  it("mastery=1 で正解、mastery=0 で不正解は不動点（更新しても動かない）", () => {
    expect(nextMastery(1, "hard", true)).toBeCloseTo(1);
    expect(nextMastery(0, "easy", false)).toBeCloseTo(0);
  });

  it("範囲外入力（防御）は [0,1] にクランプされる", () => {
    // 正常入力（prev∈[0,1]）ではクランプは発火しないため、防御用の Math.min/max を範囲外値で確認する。
    expect(nextMastery(1.5, "hard", true)).toBe(1); // 1.5 - 0.4*0.5 = 1.3 → 1
    expect(nextMastery(-0.5, "easy", false)).toBe(0); // -0.5 + 0.4*0.5 = -0.3 → 0
  });
});

// ── scoreQuestion ────────────────────────────────────────
// score = 弱点度(1-mastery, 下限 0.1) × 間隔ボーナス × レベル一致 × jitter。
// masteryMap/nowMs/rng を注入して DB なしで決定的に検証する。

type MasteryRow = { mastery: number; last_served_at: string | null };

function question(
  conceptKey: string,
  difficulty: QuizDifficulty,
  id = conceptKey,
): QuizQuestion {
  return {
    id,
    concept_key: conceptKey,
    concept_label: conceptKey,
    category: "tech/ai",
    difficulty,
    stem: "",
    choices: [],
    answer_index: 0,
    explanation: "",
    source_quote: null,
    grounded: false,
    source_ref: null,
  };
}

describe("scoreQuestion", () => {
  it("未出題 concept は PRIOR(0.3)・interval 最大・レベル一致で weakness に一致", () => {
    // mastery=PRIOR=0.3 → band easy、difficulty easy で gap0(level 1.0)、row 無しで interval=1。
    // score = weakness(0.7) * 1 * 1 * 1 = 0.7
    const s = scoreQuestion(question("c", "easy"), new Map(), NOW, noJitter);
    expect(s).toBeCloseTo(0.7);
  });

  it("習熟済み concept でも弱点度は下限 0.1 で候補に残す", () => {
    // mastery=0.95 → weakness=max(0.05, 0.1)=0.1（floor 適用）。band hard × difficulty hard で level1。
    const map = new Map<string, MasteryRow>([
      ["c", { mastery: 0.95, last_served_at: null }],
    ]);
    const s = scoreQuestion(question("c", "hard"), map, NOW, noJitter);
    expect(s).toBeCloseTo(0.1);
  });

  it("難易度帯の段差でレベル一致が 1.0 / 0.5 / 0.15 と段階的に減衰する", () => {
    // mastery=0.3 → band easy。last_served_at:null で interval=1、weakness=0.7。
    const map = new Map<string, MasteryRow>([
      ["c", { mastery: 0.3, last_served_at: null }],
    ]);
    const easy = scoreQuestion(question("c", "easy"), map, NOW, noJitter); // gap0 level1.0
    const medium = scoreQuestion(question("c", "medium"), map, NOW, noJitter); // gap1 level0.5
    const hard = scoreQuestion(question("c", "hard"), map, NOW, noJitter); // gap2 level0.15
    expect(easy).toBeCloseTo(0.7);
    expect(medium).toBeCloseTo(0.35);
    expect(hard).toBeCloseTo(0.105);
  });

  it("最終出題からの経過日数で間隔ボーナスが 0.05 → 飽和 1.0 まで立ち上がる", () => {
    // mastery=0.3・difficulty easy 固定（weakness 0.7 / level 1.0）で interval 成分だけ動かす。
    const base = (lastServedDaysAgo: number) => {
      const map = new Map<string, MasteryRow>([
        ["c", { mastery: 0.3, last_served_at: daysAgo(lastServedDaysAgo) }],
      ]);
      return scoreQuestion(question("c", "easy"), map, NOW, noJitter);
    };
    expect(base(0)).toBeCloseTo(0.7 * 0.05); // 直近出題: 下限 0.05
    expect(base(7)).toBeCloseTo(0.7 * (0.05 + 0.95 * 0.5)); // 半飽和: 0.525
    expect(base(14)).toBeCloseTo(0.7 * 1.0); // 飽和点
    expect(base(30)).toBeCloseTo(0.7 * 1.0); // 飽和以降は頭打ち
  });

  it("rng 注入で jitter が ±5% の範囲で乗る", () => {
    // 未出題 PRIOR easy の base=0.7 に jitter = 1 + 0.1*(rng-0.5) が乗る。
    const low = scoreQuestion(question("c", "easy"), new Map(), NOW, () => 0);
    const high = scoreQuestion(question("c", "easy"), new Map(), NOW, () => 1);
    expect(low).toBeCloseTo(0.7 * 0.95);
    expect(high).toBeCloseTo(0.7 * 1.05);
  });

  it("masteryBand の境界（< 0.4 / < 0.7）で帯が切り替わる", () => {
    // 境界値ごとに、その帯と gap0 になる difficulty を当てて level=1（=weakness そのまま）で固定する。
    // 帯がズレれば gap>0 で level が下がり値が変わるため、帯の帰属を一意にピン留めできる。
    const at = (mastery: number, difficulty: QuizDifficulty) => {
      const map = new Map<string, MasteryRow>([
        ["c", { mastery, last_served_at: null }],
      ]);
      return scoreQuestion(question("c", difficulty), map, NOW, noJitter);
    };
    // 上側: 0.4 は easy(<0.4) ではなく medium、0.7 は medium(<0.7) ではなく hard。
    expect(at(0.4, "medium")).toBeCloseTo(0.6); // weakness=max(0.6,0.1)=0.6
    expect(at(0.7, "hard")).toBeCloseTo(0.3); // weakness=0.3
    // 下側: 境界直下は下の帯に属する（0.39→easy, 0.69→medium）。
    expect(at(0.39, "easy")).toBeCloseTo(0.61); // easy 帯なら gap0
    expect(at(0.69, "medium")).toBeCloseTo(0.31); // medium 帯なら gap0
  });

  it("未知の難易度（防御）は medium 帯として扱う", () => {
    // difficulty が型外の値でも safeDifficulty が medium に倒す。mastery=0.3(band easy) と gap1 → level0.5。
    const map = new Map<string, MasteryRow>([
      ["c", { mastery: 0.3, last_served_at: null }],
    ]);
    const s = scoreQuestion(
      question("c", "legendary" as QuizDifficulty),
      map,
      NOW,
      noJitter,
    );
    expect(s).toBeCloseTo(0.7 * 0.5); // weakness0.7 * interval1 * level0.5
  });
});

// ── buildCategoryMastery ─────────────────────────────────

type MasteryConceptRow = {
  concept_key: string;
  concept_label: string;
  category: string;
  mastery: number;
  attempts: number;
};

function conceptRow(
  category: string,
  mastery: number,
  key = `${category}:${mastery}`,
): MasteryConceptRow {
  return {
    concept_key: key,
    concept_label: key,
    category,
    mastery,
    attempts: 1,
  };
}

describe("buildCategoryMastery", () => {
  it("空 rows は空配列", () => {
    expect(buildCategoryMastery([])).toEqual([]);
  });

  it("tech/* 以外のカテゴリは除外する", () => {
    const rows = [
      conceptRow("business/bigtech", 0.5),
      conceptRow("news/world", 0.5),
    ];
    expect(buildCategoryMastery(rows)).toEqual([]);
  });

  it("カテゴリ内 mastery を等重み平均し conceptCount を数える", () => {
    const rows = [conceptRow("tech/ai", 0.2), conceptRow("tech/ai", 0.8)];
    const result = buildCategoryMastery(rows);
    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe("tech/ai");
    expect(result[0].label).toBe(tagLabel("tech/ai"));
    expect(result[0].mastery).toBeCloseTo(0.5);
    expect(result[0].conceptCount).toBe(2);
  });

  it("weakest は mastery 昇順で上位 3 件に絞る", () => {
    const rows = [
      conceptRow("tech/ai", 0.9, "a"),
      conceptRow("tech/ai", 0.1, "b"),
      conceptRow("tech/ai", 0.5, "c"),
      conceptRow("tech/ai", 0.3, "d"),
    ];
    const weakest = buildCategoryMastery(rows)[0].weakest;
    expect(weakest.map((c) => c.concept_key)).toEqual(["b", "d", "c"]); // 0.1, 0.3, 0.5
    expect(weakest).toHaveLength(3);
  });

  it("カテゴリは TECH_LEAF_ORDER（vocabulary の tech 順）で並ぶ", () => {
    // 投入順は security → ai だが、出力は ai(先) → security の語彙順になる。
    const rows = [conceptRow("tech/security", 0.5), conceptRow("tech/ai", 0.5)];
    expect(buildCategoryMastery(rows).map((c) => c.slug)).toEqual([
      "tech/ai",
      "tech/security",
    ]);
  });
});
