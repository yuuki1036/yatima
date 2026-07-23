// embedding の cosine 類似度による近重複判定（YAT-10）。
// curate の選定ループで使う。pgvector に頼らず JS で計算し、curate を自己完結に保つ。

// 大型ニュース時に複数メディアの同内容記事が並ぶのを弾く閾値。
// 良記事を誤って落とす方が惜しいので保守的に高め。実データで skip 件数を見て調整する（tunable）。
export const DEDUP_THRESHOLD = 0.86;

// ── 学習系の dedup 閾値（YAT-56 で較正を試みた。`npm run diagnose-dedup` で再測定できる）──
//
// 結論: **どちらも 0.86 のまま据え置いた。** 較正に必要な観測が成立しないと分かったため。
// 分かったことは下の各定数のコメントに残す。

// YAT-17: カード候補専用の dedup 閾値。
// YAT-56: **0.86 を維持**。maxSim 中央値 0.740 に対し閾値は十分上にあり、0.84 / 0.86 / 0.88 の
// いずれでも dup 件数は 4 で変わらない（プラトーの中央＝境界に敏感でない）。動かす根拠が無い。
// なお card 側は閾値超でも insert して dup_flag を立てるだけの非破壊判定だが、その dup_flag を読む
// 経路は現在存在しない（承認 UI は YAT-27 で撤去済み・YAT-59）。実効性が無いので優先度も低い。
export const CARD_DEDUP_THRESHOLD = 0.86;

// YAT-29: 適応クイズ問題専用の dedup 閾値。
// YAT-56: **0.86 を維持**（一度 0.90 へ上げたが、根拠不足と判断して差し戻した）。
//
// 分かったこと:
// - MCQ の兄弟は構造的に似る。合成テキスト（stem＋選択肢4件＋source_quote 200 字）は記事の語彙に
//   強く引っ張られ、maxSim 中央値は 0.819（card は 0.740）。**card と別値にすべき示唆はある**
// - 0.86〜0.90 帯の 8 組を目視すると、真の重複と別設問が混在している
//
// それでも動かさなかった理由（いずれも当時 quiz が skip 方式＝近重複を insert しなかったことに由来）:
// - **弾いた候補を観測できなかった。** ゲートが捨てたものは DB に残らず、「閾値が厳しすぎるか」を
//   判定する標本そのものが手に入らなかった
// - 現存プールを見ても代用にならない。0.90 以上のペアが 17 組残っており、これはゲートが唯一の
//   入口でないことを示していた（YAT-56 以前はオンデマンド経路が dedup を通らず insert していた。
//   この穴は quiz-gate の embedAndDedupQuizRows で塞いだ）。目視した 8 組も、ゲートを通った行と
//   通らなかった行が混ざった母集団から取れたもので、「ゲートが弾いた候補の標本」ではない
// - 「近い設問が 1 問残っても selectSessionQuestions の concept 重複回避が緩衝する」と考えたが、
//   これは成り立たない。0.86〜0.90 帯の 8 組は 8/8 が concept_key 不一致で、そもそも
//   generate-quiz のプロンプトが「1 問 1 概念で互いに重複させないこと」を課すため、同一記事の
//   兄弟は設計上必ず別 concept になる
//
// YAT-61: **観測手段は用意した。** skip をやめて dup_flag を立てて insert する方式へ移行し
// （quiz-gate の markQuizDuplicates）、選定側の除外（mastery の selectSessionQuestions）と
// 充足数え側の除外（quiz-pool の countActive）も揃えた。生の類似度は dup_similarity 列に残す。
// **ただし移行前に積まれた行は dup_similarity を持たないため、標本は移行後の生成が貯まるまで 0 件。**
// 較正の再開は `npm run diagnose-dedup` の「保存済み dup_similarity」スイープを見てから。
// 現存プールの再計算スイープは通過した側しか含まないので、そちらでは判断しないこと。
export const QUIZ_DEDUP_THRESHOLD = 0.86;

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
