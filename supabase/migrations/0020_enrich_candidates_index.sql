-- 本文補完（enrich）の候補取得を seq scan から index scan にする（YAT-77 hotfix・0019 の後続）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 冪等: index は if not exists。
--
-- 症状: ingest の「本文取得対象の取得に失敗: code 57014 canceling statement due to statement timeout」が
--   毎 run 出て、本文補完が「対象 0 件」で静かに空振りし続けている（2026-09-19 20:44 / 23:10 UTC）。
--   enrichMissingBodies は fail-soft（catch して 0 件を返す）なので run は赤くならず、
--   要約の入力が薄い本文のまま進む＝ハルシネーションが増える方向に静かに劣化する。
--
-- 原因: lib/rss/enrich.ts の候補取得は
--     summary is null and enriched_at is null and url is not null
--     and (body_text_len < 300 or body_text_len is null)
--     order by published_at desc nulls last limit 20
--   だが、この述語に効く index が無い。プランナは idx_articles_published_at（全行・desc）を
--   新しい順に舐めて条件に合う 20 件を探すしかなく、要約済みの記事が積み上がるほど
--   先頭から該当行までの距離が伸びる。無料枠の共有 CPU では statement_timeout（約 8s）を跨ぐ。
--
-- 対処: 「まだ要約されていない × まだ enrich を試していない × URL がある」行だけの部分 index を
--   published_at desc nulls last で張る。この 3 条件はどれも一度立つと戻らない（enrich は成否に
--   関わらず enriched_at を立てる・要約は summary を埋める）ので、処理済みの行は index から
--   自動的に抜ける＝index は「これから処理する数十〜数百行」に留まり続ける。
--   order by の nulls last は index 側と揃える必要がある（desc の既定は nulls first）。
--   body_text_len の条件は index 述語に入れない: 0017 の trigger 値で更新されうる列を述語に
--   焼き込むと閾値変更で静かに効かなくなる（idx_articles_embed_pending で踏んだ罠）。
--   残った数十行への filter なので index scan の後で十分安い。
--   CONCURRENTLY は使わない（migrate ランナーが各ファイルを begin/commit で包むため）。
--
-- 設計: .claude/designs/20260906-llm-cost-batches-embed-decoupling.md
-- 関連: 0017（enriched_at / body_text_len の導入）、0018・0019（同種 timeout の対処）

create index if not exists idx_articles_enrich_pending
  on public.articles (published_at desc nulls last)
  where summary is null and enriched_at is null and url is not null;
