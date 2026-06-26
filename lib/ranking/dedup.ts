// embedding の cosine 類似度による近重複判定（YAT-10）。
// curate の選定ループで使う。pgvector に頼らず JS で計算し、curate を自己完結に保つ。

// 大型ニュース時に複数メディアの同内容記事が並ぶのを弾く閾値。
// 良記事を誤って落とす方が惜しいので保守的に高め。実データで skip 件数を見て調整する（tunable）。
export const DEDUP_THRESHOLD = 0.86;

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
