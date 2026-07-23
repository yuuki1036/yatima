-- 0013_quiz_dup_similarity.sql — quiz の dedup を skip から dup_flag 方式へ（YAT-61）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 0001〜0012 を壊さず追加のみ。既存行は触らない（下記「既存プールの扱い」参照）。
--
-- ⚠ コードのデプロイより先に適用すること。markQuizDuplicates は全行に dup_similarity を必ず付ける
-- ため、列が無い DB では PostgREST が bulk insert をリクエストごと拒否する（1 行でも失敗すると
-- 全体 rollback）。insertQuizRows は fail-soft で warn するだけなので、cron は緑のまま生成 0 が続く。

-- quiz_questions.dup_flag（0011 で予約済み・未使用）を実際に使い始める。skip 方式では
-- ゲートが弾いた候補が DB に一切残らず、閾値の妥当性を判定する標本が原理的に手に入らなかった
-- （YAT-56 の較正がこれに阻まれて差し戻し）。card_candidates と同じく「insert してフラグを立てる」
-- 非破壊方式に揃え、弾いた候補を観測可能にする。
--
-- dup_similarity は最も近い既存候補との cosine。dup_flag（閾値との比較結果）だけでは閾値を
-- 動かしたときの件数変化が測れないため、生の類似度を残す（card_candidates.dup_similarity と同義）。
alter table public.quiz_questions
  add column if not exists dup_similarity real;

-- 出題プールの引き当て（selectSessionQuestions）と deficit の充足数え（countActive）は
-- dup_flag = false に絞る。「数える母集団」と「出題する母集団」を揃えないと、近重複が積まれるほど
-- プールが満ちたと誤認して補充が止まり、出題可能な問題が枯れる。
--
-- index は当面 idx_quiz_questions_serve（category, status, created_at desc）のまま据え置く。
-- ただし**「プール深度は ≈100 行で頭打ち」という旧前提はこの変更で成立しなくなった**: dup 行は
-- active として残る一方 deficit を埋めないため、行数は単調に増える（増加ペースは週次 cron の
-- MAX_NEW_PER_RUN=24 とセッション補充が上限なので緩やか）。据え置きは「当面の規模では不要」で
-- あって「原理的に不要」ではない。較正が済んで dup_similarity の標本が不要になった時点で、
-- dup 行の retire か dedup 母集団の窓切りとあわせて index を見直すこと。
--
-- 既存プールの扱い: 遡って dup_flag は立てない。既存行は skip 方式時代のもので、しかも
-- YAT-56 で塞ぐまでオンデマンド経路が dedup を通らず insert していた混合物のため、
-- 遡って flag を立てても「ゲートが弾いた候補」の標本にはならない（由来が違う）。
-- 較正の標本は、この migration 以降に dup_flag=true で積まれた行から取る。
