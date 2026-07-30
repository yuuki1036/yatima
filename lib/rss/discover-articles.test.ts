import { describe, expect, it } from "vitest";
import {
  passesCandidateGate,
  CANDIDATE_GATE_THRESHOLDS,
  type BlogShapeInput,
} from "./discover-articles";

// YAT-65: 候補登録ゲートの境界値テスト。
// ゲートは「参照元 1 媒体以上」を下限に、①2 媒体以上 または ②1 媒体でもブログ形（blogScore >= 2）
// を通す。②は「個人ブログは構造的に被参照数が少ないので人気度だけで切ると狙った獲物ほど落ちる」
// という判断で置いた逃げ道であり、これが壊れると方式①の目的が静かに死ぬ（承認 UI からは
// 「候補が来ない」ようにしか見えず、原因に辿り着けない）。ゆえに境界を固定する。
//
// mutation-test-what-the-test-actually-guards に従い「判定ロジックの固定」と「値の固定」を
// 別のテストとして持つ（前者だけだと閾値の数値を書き換えても気づけない）。

function candidate(over: Partial<BlogShapeInput> = {}): BlogShapeInput {
  return {
    domain: "example.com",
    sourceDomains: new Set<string>(),
    hostCounts: new Map<string, number>(),
    blogPathHit: false,
    ...over,
  };
}

describe("passesCandidateGate", () => {
  describe("下限（参照元 0 媒体）", () => {
    // articles.url は nullable なので、参照元記事の url が全て解決できないと size が 0 になる。
    // 0 媒体を通すと discovered_from が article-links:0src になり、parseArticleLinksSourceCount が
    // n > 0 を要求するため承認 UI の媒体バッジが丸ごと消える。ブログ形でも通さない。
    it("0 媒体はブログ形でも落とす", () => {
      expect(
        passesCandidateGate(
          candidate({ domain: "someone.github.io", blogPathHit: true }),
        ),
      ).toBe(false);
    });
  });

  describe("① 人気度の主軸", () => {
    it("2 媒体はブログ形でなくても通る（大手メディア相当）", () => {
      expect(
        passesCandidateGate(
          candidate({
            domain: "theverge.com",
            sourceDomains: new Set(["a.com", "b.com"]),
          }),
        ),
      ).toBe(true);
    });

    it("1 媒体でブログ的シグナルが無ければ落ちる", () => {
      expect(
        passesCandidateGate(
          candidate({ domain: "npr.org", sourceDomains: new Set(["a.com"]) }),
        ),
      ).toBe(false);
    });
  });

  describe("② ブログ形の逃げ道（1 媒体）", () => {
    it("ブログ基盤なら +2 単独で通る", () => {
      expect(
        passesCandidateGate(
          candidate({
            domain: "thezvi.substack.com",
            sourceDomains: new Set(["a.com"]),
          }),
        ),
      ).toBe(true);
    });

    it("blog.* サブドメインだけ（+1）では足りない", () => {
      expect(
        passesCandidateGate(
          candidate({
            domain: "sparkly.sh",
            sourceDomains: new Set(["a.com"]),
            hostCounts: new Map([["blog.sparkly.sh", 1]]),
          }),
        ),
      ).toBe(false);
    });

    it("ブログ的パスだけ（+1）では足りない", () => {
      expect(
        passesCandidateGate(
          candidate({
            domain: "sparkly.sh",
            sourceDomains: new Set(["a.com"]),
            blogPathHit: true,
          }),
        ),
      ).toBe(false);
    });

    it("blog.* サブドメイン + ブログ的パス（+1 +1）で通る", () => {
      expect(
        passesCandidateGate(
          candidate({
            domain: "sparkly.sh",
            sourceDomains: new Set(["a.com"]),
            hostCounts: new Map([["blog.sparkly.sh", 1]]),
            blogPathHit: true,
          }),
        ),
      ).toBe(true);
    });

    it("blog.* は複数ホストあっても加点は 1 回だけ（break がある）", () => {
      // +1 が 2 回入ると 2 に達して通ってしまう。break の存在をここで固定する。
      expect(
        passesCandidateGate(
          candidate({
            domain: "sparkly.sh",
            sourceDomains: new Set(["a.com"]),
            hostCounts: new Map([
              ["blog.sparkly.sh", 1],
              ["blog.old.sparkly.sh", 1],
            ]),
          }),
        ),
      ).toBe(false);
    });

    it("ブログ基盤はサブドメインでも一致する（eTLD+1 のマルチテナント補正）", () => {
      expect(
        passesCandidateGate(
          candidate({
            domain: "colah.github.io",
            sourceDomains: new Set(["a.com"]),
          }),
        ),
      ).toBe(true);
    });
  });

  describe("閾値の値スナップショット", () => {
    // 判定ロジックのテストは閾値の数値を変えても通ってしまうため、値そのものを固定する。
    // ここが落ちたら「意図して動かしたのか」を確認してから更新する。
    it("MIN_DISTINCT_SOURCES / MIN_BLOG_SCORE_FOR_SINGLE_SOURCE の値", () => {
      expect(CANDIDATE_GATE_THRESHOLDS).toEqual({
        MIN_DISTINCT_SOURCES: 2,
        MIN_BLOG_SCORE_FOR_SINGLE_SOURCE: 2,
      });
    });

    it("表示層の NOTABLE_SOURCE_COUNT と主軸しきい値が一致している", async () => {
      // 語彙の一致（2 媒体以上＝強いシグナル）を規約として固定する。層をまたぐので import は
      // せず定数は別々に持つ方針だが、値がズレたらどちらかの意図が変わったということ。
      const { NOTABLE_SOURCE_COUNT } = await import(
        "../feeds/discovery-display"
      );
      expect(CANDIDATE_GATE_THRESHOLDS.MIN_DISTINCT_SOURCES).toBe(
        NOTABLE_SOURCE_COUNT,
      );
    });
  });
});
