// embedding の cosine 類似度による近重複判定（YAT-10）。
// curate の選定ループで使う。pgvector に頼らず JS で計算し、curate を自己完結に保つ。

// 大型ニュース時に複数メディアの同内容記事が並ぶのを弾く閾値。
// 良記事を誤って落とす方が惜しいので保守的に高め。実データで skip 件数を見て調整する（tunable）。
export const DEDUP_THRESHOLD = 0.86;

// ── 学習系の dedup 閾値（YAT-56 で実データ較正済み。`npm run diagnose-dedup` で再測定できる）──
//
// 較正時（2026-07-21）に共通して分かったこと: **閾値以上のペアは card / quiz とも 100% が
// 同一ソース内**（card 23 件・quiz 71 件で計測。ソース跨ぎのペアが現れるのは 0.84 以下）。
// つまりこのゲートが実際に担っているのは「別記事の重複を弾く」ことではなく、
// 「1 記事から複数生成した兄弟の冗長性を抑える」こと。閾値はその観点で決める。

// YAT-17: カード候補専用の dedup 閾値。
// YAT-56 の較正: **0.86 を維持**。maxSim 中央値 0.740 に対し閾値は十分上にあり、
// 0.84 / 0.86 / 0.88 のいずれでも dup 件数は 4 で変わらない（プラトーの中央＝境界に敏感でない）。
// card 側は閾値超でも insert し dup_flag を立てるだけの非破壊判定なので、誤検出のコストも低い。
export const CARD_DEDUP_THRESHOLD = 0.86;

// YAT-29: 適応クイズ問題専用の dedup 閾値。
// YAT-56 の較正: **0.86 → 0.90 へ引き上げ**。card と非対称にする理由は 3 つ。
// 1. MCQ の兄弟は構造的に似る。stem＋選択肢4件の合成テキストは記事の語彙に強く引っ張られ、
//    maxSim 中央値が 0.819（card は 0.740）。同じ閾値では「別観点の設問」まで巻き込む。
// 2. 0.86〜0.90 帯のペアを目視したところ、真の重複（同じ論点の言い換え）と別設問
//    （例: 「63回中16回成功の含意」vs「評価タスクの共通特徴」）が混在していた。0.90 以上は
//    ほぼ真の重複だけになる。
// 3. **quiz 側の棄却は破壊的**（dup_flag を立てず insert しない = 二度と復元できない）。
//    プールは 71 問と薄く、正当な設問を失うコストのほうが、近い設問が 1 問残るコストより高い。
//    出題時に selectSessionQuestions が concept 重複を避けるため、多少の近似は緩衝される。
// 副作用: 真の重複が数件通るようになる（計測上 0.86→0.90 で dup 判定は 15→12 件）。
export const QUIZ_DEDUP_THRESHOLD = 0.9;

// PostgREST が返す vector 列は文字列 "[v1,v2,...]"。number[] にパースする。
// 不正値（null / パース不可 / 空）は null を返し、呼び出し側で「embedding 無し＝非重複」に倒す。
export function parseEmbedding(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length > 0 ? (v as number[]) : null;
  } catch {
    return null;
  }
}

// cosine 類似度。次元不一致や零ベクトルは 0（非類似）を返す。
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// candidate が既選 vectors のいずれかと閾値超で類似するか（＝近重複か）。
export function isNearDuplicate(
  candidate: number[],
  picked: number[][],
  threshold = DEDUP_THRESHOLD,
): boolean {
  for (const p of picked) {
    if (cosineSim(candidate, p) >= threshold) return true;
  }
  return false;
}
