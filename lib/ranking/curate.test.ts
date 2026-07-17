import { describe, it, expect } from "vitest";
import { pickDeck, type DeckCandidate, type DeckSeed } from "@/lib/ranking/curate";

// YAT-54: デッキ選定の純関数 pickDeck のユニットテスト。
// 3 パス（探索枠 → 通常 → fallback）× 多様性キャップ × dedup 継続が絡む最も分岐の多いロジック。
// DB IO を持たない純関数なのでモック不要。curateToday（DB 依存）はスコープ外。

// dedup は既定閾値 0.86（cosine）。以下の単位ベクトルは相互に cosine < 0.86 で「非重複」、
// 同一ベクトルどうしは cosine 1 で「近重複」になる。
const VA = [1, 0];
const VB = [0, 1];
const VC = [-1, 0];
const VD = [0, -1];

// feedId は既定で id と同一（ソース衝突を避ける）。多様性キャップを試す時だけ明示的に共有させる。
function cand(id: string, over: Partial<DeckCandidate> = {}): DeckCandidate {
  return {
    id,
    feedId: id,
    vec: null,
    pref: 5, // 既定は非中立（探索枠に拾われない）
    recency: 0,
    value: 0,
    ...over,
  };
}

function seed(over: Partial<DeckSeed> = {}): DeckSeed {
  return { feedId: null, vec: null, pref: 5, judged: false, ...over };
}

describe("pickDeck: 基本と日次上限（need）", () => {
  it("スコア降順で need 件だけ補充し、それ以上は採らない", () => {
    const candidates = [
      cand("a", { value: 4 }),
      cand("b", { value: 3 }),
      cand("c", { value: 2 }),
      cand("d", { value: 1 }),
    ];
    const r = pickDeck({ candidates, seeds: [], need: 2, hasPrefSignal: false });
    expect(r.scored.map((s) => s.id)).toEqual(["a", "b"]); // 上位 2 件
    expect(r.explored).toBe(0);
    expect(r.deduped).toBe(0);
  });

  it("候補が空なら空デッキ", () => {
    const r = pickDeck({ candidates: [], seeds: [], need: 3, hasPrefSignal: false });
    expect(r.scored).toEqual([]);
    expect(r.deduped).toBe(0);
    expect(r.explored).toBe(0);
  });
});

describe("pickDeck: 多様性キャップ", () => {
  it("通常パスは同一ソースを maxPerSource(3) までに抑える", () => {
    // f1 に 4 件（値の高い順）＋ f2 に 1 件。need=4 なら f1 は 3 件で頭打ち、4 件目より値の低い
    // f2 が入る。fallback は need 充足済みで発火しない（＝cap が確定的に効く）。
    const candidates = [
      cand("f1a", { feedId: "f1", value: 10 }),
      cand("f1b", { feedId: "f1", value: 9 }),
      cand("f1c", { feedId: "f1", value: 8 }),
      cand("f1d", { feedId: "f1", value: 7 }),
      cand("f2a", { feedId: "f2", value: 1 }),
    ];
    const r = pickDeck({ candidates, seeds: [], need: 4, hasPrefSignal: false });
    expect(r.scored.map((s) => s.id)).toEqual(["f1a", "f1b", "f1c", "f2a"]);
    expect(r.scored.map((s) => s.id)).not.toContain("f1d"); // cap で除外
  });

  it("maxPerSource は上書きできる", () => {
    const candidates = [
      cand("f1a", { feedId: "f1", value: 10 }),
      cand("f1b", { feedId: "f1", value: 9 }),
      cand("f1c", { feedId: "f1", value: 8 }),
      cand("f2a", { feedId: "f2", value: 1 }),
    ];
    // maxPerSource=2 なら f1 は 2 件で頭打ち。need=3 は f2 で満たす（fallback 未発火）。
    const r = pickDeck({
      candidates,
      seeds: [],
      need: 3,
      hasPrefSignal: false,
      maxPerSource: 2,
    });
    expect(r.scored.map((s) => s.id)).toEqual(["f1a", "f1b", "f2a"]);
  });

  it("既出 seed も同一ソース数に累積カウントする", () => {
    // f1 の既出 1 件を seed に積むと、補充で採れる f1 は残り 2 件（maxPerSource 3 − 既出 1）。
    const candidates = [
      cand("f1a", { feedId: "f1", value: 10 }),
      cand("f1b", { feedId: "f1", value: 9 }),
      cand("f1c", { feedId: "f1", value: 8 }),
      cand("f2a", { feedId: "f2", value: 1 }),
    ];
    const seeds = [seed({ feedId: "f1", judged: true })];
    const r = pickDeck({ candidates, seeds, need: 3, hasPrefSignal: false });
    expect(r.scored.map((s) => s.id)).toEqual(["f1a", "f1b", "f2a"]); // f1c は既出込み cap で除外
  });
});

describe("pickDeck: dedup（近重複除外）", () => {
  it("既出 seed と近重複な候補を弾く", () => {
    const candidates = [
      cand("dup", { value: 10, vec: VA }), // seed と同一ベクトル → 近重複
      cand("keep", { value: 9, vec: VB }),
    ];
    const seeds = [seed({ vec: VA })]; // 既出の embedding
    const r = pickDeck({ candidates, seeds, need: 1, hasPrefSignal: false });
    expect(r.scored.map((s) => s.id)).toEqual(["keep"]);
    expect(r.deduped).toBe(1); // dup は 1 回弾かれる（need=1 で充足し fallback 未発火）
  });

  it("採用済み候補どうしの近重複も継続して弾く", () => {
    // 値の高い順に採ると first が入り、その near-dup の second は弾かれ、非重複の third が入る。
    const candidates = [
      cand("first", { value: 10, vec: VA }),
      cand("second", { value: 9, vec: VA }), // first と同一ベクトル
      cand("third", { value: 8, vec: VB }),
    ];
    const r = pickDeck({ candidates, seeds: [], need: 2, hasPrefSignal: false });
    expect(r.scored.map((s) => s.id)).toEqual(["first", "third"]);
    expect(r.deduped).toBe(1);
  });

  it("embedding 無し（vec=null）の候補は非重複扱いで素通しする", () => {
    const candidates = [
      cand("x", { value: 10, vec: null }),
      cand("y", { value: 9, vec: null }),
    ];
    const seeds = [seed({ vec: VA })];
    const r = pickDeck({ candidates, seeds, need: 2, hasPrefSignal: false });
    expect(r.scored.map((s) => s.id)).toEqual(["x", "y"]);
    expect(r.deduped).toBe(0);
  });
});

// 注: deduped は「dedup 判定に到達して弾かれた回数」であり distinct な近重複候補数ではない。
// 同一 dup 候補が通常パスと fallback の両方で dedup 判定に達すると 2 計上される（下記 2 テストの差）。
describe("pickDeck: fallback（cap 緩和・dedup 維持）", () => {
  it("need を満たせない時は cap を緩和して充足するが、dedup は維持する", () => {
    // 全件 f1（同一ソース）。need=4 だが通常パスは cap 3 で止まる。fallback で cap を外して 4 件目を
    // 足すが、first と近重複な dup は fallback でも弾き続ける（knowledge: continuous-topup-curation の罠）。
    const candidates = [
      cand("A", { feedId: "f1", value: 10, vec: VA }),
      cand("B", { feedId: "f1", value: 9, vec: VB }),
      cand("C", { feedId: "f1", value: 8, vec: VC }),
      cand("dup", { feedId: "f1", value: 7, vec: VA }), // A と近重複
      cand("E", { feedId: "f1", value: 6, vec: VD }),
    ];
    const r = pickDeck({ candidates, seeds: [], need: 4, hasPrefSignal: false });
    // A/B/C を通常パスで採り（cap 到達）、fallback で cap を外し dup を dedup で飛ばして E を採る。
    expect(r.scored.map((s) => s.id)).toEqual(["A", "B", "C", "E"]);
    expect(r.scored.map((s) => s.id)).not.toContain("dup");
    expect(r.deduped).toBe(1); // dup は fallback でのみ dedup 判定に到達（通常パスは cap で先に落ちる）
  });

  it("cap を緩和しても非重複候補が尽きれば need 未満で返る", () => {
    // f1 3 件のうち 1 件が A の near-dup。need=4 でも非重複は 3 件しかなく、それ以上は埋まらない。
    const candidates = [
      cand("A", { feedId: "f1", value: 10, vec: VA }),
      cand("B", { feedId: "f1", value: 9, vec: VB }),
      cand("dup", { feedId: "f1", value: 8, vec: VA }),
    ];
    const r = pickDeck({ candidates, seeds: [], need: 4, hasPrefSignal: false });
    expect(r.scored.map((s) => s.id)).toEqual(["A", "B"]);
    // ここでは f1 が cap(3) に達しないため dup は通常パスでも dedup 判定に到達し、fallback で再評価
    // されて計 2 回弾かれる（cap で先に落ちる前段の fallback テストとの差）。
    expect(r.deduped).toBe(2);
  });
});

describe("pickDeck: 探索枠（嗜好中立帯）", () => {
  it("嗜好シグナルありなら中立候補を recency 降順で exploreCount(2) 件確保する", () => {
    const candidates = [
      // 中立（|pref| <= 0.5）。recency 降順に採られる。
      cand("p1", { pref: 0, recency: 0.9, value: 1 }),
      cand("p2", { pref: 0.2, recency: 0.8, value: 1 }),
      cand("p3", { pref: -0.3, recency: 0.7, value: 1 }),
      // 非中立・高スコア（通常パスで採られる）。
      cand("n1", { pref: 5, recency: 0.5, value: 100 }),
      cand("n2", { pref: 5, recency: 0.4, value: 90 }),
    ];
    const r = pickDeck({ candidates, seeds: [], need: 4, hasPrefSignal: true });
    expect(r.explored).toBe(2);
    // 採用順は決定的: 探索枠が recency 降順 p1→p2、続いて通常パスが値降順 n1→n2。配列で固定して
    // 順序と件数（探索採用済みが通常パスで二重に採られないこと）まで検証する。p3 は recency 下位で漏れる。
    expect(r.scored.map((s) => s.id)).toEqual(["p1", "p2", "n1", "n2"]);
  });

  it("探索枠は need を上限にクランプする（need < exploreCount でも超過採用しない）", () => {
    // 中立候補は 2 件あるが need=1。exploreNeed = min(exploreCount 2, need 1) = 1 で 1 件に抑える。
    // このクランプが無いと explored=2・scored 2 件となり日次上限（size 件打ち止め）を破る。
    const candidates = [
      cand("p1", { pref: 0, recency: 0.9, value: 1 }),
      cand("p2", { pref: 0, recency: 0.8, value: 1 }),
    ];
    const r = pickDeck({ candidates, seeds: [], need: 1, hasPrefSignal: true });
    expect(r.explored).toBe(1);
    expect(r.scored).toHaveLength(1);
  });

  it("探索枠パスでも既出 seed との近重複は弾く", () => {
    // 探索候補の採否も cap/dedup を通す（探索枠が別メディア重複を再導入しない）。need=1 に絞り、
    // 探索パス単独の挙動を見る（通常/fallback は need 充足で発火しないので deduped は 1 回だけ）。
    const candidates = [
      cand("pdup", { pref: 0, recency: 0.9, value: 1, vec: VA }), // seed と近重複（recency 上位）
      cand("pkeep", { pref: 0, recency: 0.8, value: 1, vec: VB }),
    ];
    const seeds = [seed({ vec: VA, judged: true })]; // judged=true で探索枠カウントには効かせない
    const r = pickDeck({ candidates, seeds, need: 1, hasPrefSignal: true });
    expect(r.explored).toBe(1); // pdup は dedup で探索枠に入れず pkeep のみ
    expect(r.scored.map((s) => s.id)).toEqual(["pkeep"]);
    expect(r.deduped).toBe(1);
  });

  it("neutralBand の上書きで中立判定が狭まる", () => {
    // 既定 0.5 なら中立だが、0.1 に絞ると pref=0.2 は非中立になり探索枠に拾われない。
    const candidates = [
      cand("p", { pref: 0.2, recency: 0.9, value: 1 }),
      cand("n1", { pref: 5, recency: 0.5, value: 100 }),
      cand("n2", { pref: 5, recency: 0.4, value: 90 }),
    ];
    const r = pickDeck({
      candidates,
      seeds: [],
      need: 3,
      hasPrefSignal: true,
      neutralBand: 0.1,
    });
    expect(r.explored).toBe(0);
  });

  it("コールドスタート（hasPrefSignal=false）は探索枠を畳む", () => {
    const candidates = [
      cand("p1", { pref: 0, recency: 0.9, value: 1 }),
      cand("p2", { pref: 0, recency: 0.8, value: 1 }),
      cand("n1", { pref: 5, recency: 0.5, value: 100 }),
      cand("n2", { pref: 5, recency: 0.4, value: 90 }),
    ];
    const r = pickDeck({ candidates, seeds: [], need: 4, hasPrefSignal: false });
    expect(r.explored).toBe(0);
    expect(r.scored.map((s) => s.id)).toContain("n1"); // 値順で拾われる
    expect(r.scored).toHaveLength(4);
  });

  it("中立候補が不足なら確保できる分だけ（残りは通常パス）", () => {
    const candidates = [
      cand("p1", { pref: 0, recency: 0.9, value: 1 }), // 中立は 1 件のみ
      cand("n1", { pref: 5, recency: 0.5, value: 100 }),
      cand("n2", { pref: 5, recency: 0.4, value: 90 }),
    ];
    const r = pickDeck({ candidates, seeds: [], need: 3, hasPrefSignal: true });
    expect(r.explored).toBe(1);
    expect(r.scored).toHaveLength(3); // 探索 1 + 通常 2（二重採用なし）
  });

  it("未判定かつ中立な既出 seed は探索枠の充足に数える（その分 exploreNeed が減る）", () => {
    const candidates = [
      cand("p1", { pref: 0, recency: 0.9, value: 1 }),
      cand("p2", { pref: 0, recency: 0.8, value: 1 }),
      cand("n1", { pref: 5, recency: 0.5, value: 100 }),
    ];
    // 未判定・中立の既出が 1 件 → 探索枠 2 のうち 1 が既に埋まっている扱い。
    const seeds = [seed({ pref: 0, judged: false })];
    const r = pickDeck({ candidates, seeds, need: 3, hasPrefSignal: true });
    expect(r.explored).toBe(1);
    expect(r.scored).toHaveLength(3);
  });

  it("判定済みの中立 seed は探索枠にカウントしない", () => {
    const candidates = [
      cand("p1", { pref: 0, recency: 0.9, value: 1 }),
      cand("p2", { pref: 0, recency: 0.8, value: 1 }),
      cand("n1", { pref: 5, recency: 0.5, value: 100 }),
    ];
    // judged=true の中立既出は消化済み → 探索枠は 2 のまま。
    const seeds = [seed({ pref: 0, judged: true })];
    const r = pickDeck({ candidates, seeds, need: 3, hasPrefSignal: true });
    expect(r.explored).toBe(2);
    expect(r.scored).toHaveLength(3);
  });
});
