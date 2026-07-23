-- 0013_quiz_dup_similarity.sql — quiz の dedup を skip から dup_flag 方式へ（YAT-61）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 0001〜0012 を壊さず追加のみ。既存行は触らない（下記「既存プールの扱い」参照）。

-- quiz_questions.dup_flag（0011 で予約済み・未使用）を実際に使い始める。skip 方式では
-- ゲートが弾いた候補が DB に一切残らず、閾値の妥当性を判定する標本が原理的に手に入らなかった
-- （YAT-56 の較正がこれに阻まれて差し戻し）。card_candidates と同じく「insert してフラグを立てる」
-- 非破壊方式に揃え、弾いた候補を観測可能にする。
--
-- dup_similarity は最も近い既存候補との cosine。dup_flag（閾値との比較結果）だけでは閾値を
-- 動かしたときの件数変化が測れないため、生の類似度を残す（card_candidates.dup_similarity と同義）。
alter table public.quiz_questions
  add column if not exists dup_similarity real;

-- 出題プールの引き当ては dup_flag = false に絞る（selectSessionQuestions）。プール深度は
-- POOL_TARGET×カテゴリ数（≈100 行）で頭打ちなので、既存の idx_quiz_questions_serve
-- （category, status, created_at desc）で足りる。dup_flag を index に足すのはプールが桁で
-- 増えてからでよい。
--
-- 既存プールの扱い: 遡って dup_flag は立てない。既存行は skip 方式時代のもので、しかも
-- YAT-56 で塞ぐまでオンデマンド経路が dedup を通らず insert していた混合物のため、
-- 遡って flag を立てても「ゲートが弾いた候補」の標本にはならない（由来が違う）。
-- 較正の標本は、この migration 以降に dup_flag=true で積まれた行から取る。
