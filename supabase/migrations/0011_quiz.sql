-- 0011_quiz.sql — 学習 Module 再起動: 適応クイズ MVP（YAT-27）
-- 適用方法: npm run migrate（SUPABASE_DB_URL 必要）
--           または Supabase ダッシュボード > SQL Editor に貼り付け
-- 0001〜0010 を壊さず追加のみ。旧 card_candidates（0007）は撤去せず凍結し、
-- /learn の入口だけ適応クイズへ差し替える（design doc 20260702-adaptive-quiz-learn-mode）。

-- pgvector は 0003 で有効化済みだが、ダッシュボードに 0011 単独を貼る運用でも壊れないよう冪等に再宣言する。
create extension if not exists vector;

-- ── quiz_questions: 出題プール（LLM 生成 MCQ を形式検証＋grounding 通過後に積む）────────
-- カテゴリ選択→記事駆動で生成した選択式問題。source_quote は content_html への逐語照合で担保する
-- （照合失敗は quiz-gate が捨てる＝grounded=true のみ insert する MVP。ungrounded 経路は後続）。
-- embedding は dedup 母集団用（embed 失敗分は null で積み、YAT-29 の cron が後追いで埋める）。
-- dup_flag は YAT-29 が skip 方式（近重複を insert しない）を採ったため長らく未使用の予約列だったが、
-- YAT-61 で本来の想定どおり「insert してフラグを立てる」方式に戻した（skip では弾いた候補が DB に
-- 残らず閾値を較正できないため）。生の類似度 dup_similarity は 0013 で追加。
-- 出題側（selectSessionQuestions）は dup_flag = false に絞る。status で active/retired を管理し行は消さない。
create table if not exists public.quiz_questions (
  id             uuid primary key default gen_random_uuid(),
  concept_key    text not null,                     -- 正規化 slug（例 react-hooks）。mastery 集計軸
  concept_label  text not null,                     -- 表示名（例「React Hooks」）
  category       text not null,                     -- tech/* 等の固定カテゴリへ集約（vocabulary の leaf）
  difficulty     text not null,                     -- 'easy' | 'medium' | 'hard'
  stem           text not null,                     -- 設問文
  choices        jsonb not null,                    -- 選択肢 string[4]
  answer_index   int not null,                      -- 正解の 0-based index（0..3）
  explanation    text not null,                     -- 一言解説
  source_quote   text,                              -- grounding 根拠（原文の逐語抜粋）。ungrounded は null
  grounded       boolean not null default false,    -- 逐語照合を通過したか（MVP は true のみ積む）
  source_ref     text,                              -- 由来 article_id 等（FK なし＝記事削除で問題は残す）
  -- dedup 母集団用。articles.embedding と同じ Voyage 1024 次元（0003_embeddings.sql）。MVP は null。
  embedding      vector(1024),
  dup_flag       boolean not null default false,    -- 近重複フラグ。自動削除せず出題プールから外すだけ（YAT-61）
  status         text not null default 'active',    -- active → retired（誤り報告・退役）
  created_at     timestamptz not null default now(),
  constraint quiz_questions_difficulty_chk
    check (difficulty in ('easy', 'medium', 'hard')),
  constraint quiz_questions_status_chk
    check (status in ('active', 'retired')),
  constraint quiz_questions_answer_index_chk
    check (answer_index between 0 and 3),
  -- 選択肢は必ず4件（形式ゲートの二重保険。jsonb 配列長を DB でも縛る）。
  constraint quiz_questions_choices_len_chk
    check (jsonb_array_length(choices) = 4)
);

-- 出題プールの引き当て（カテゴリ×active を新しい順）。selectSessionQuestions の主クエリ。
create index if not exists idx_quiz_questions_serve
  on public.quiz_questions (category, status, created_at desc);
-- concept 単位の引き当て（YAT-28 の弱点補完・プール薄判定）。
create index if not exists idx_quiz_questions_concept
  on public.quiz_questions (concept_key);

-- ── quiz_attempts: 回答ログ（採点結果の元帳）────────────────────────────
-- 1 回答 1 行。mastery 更新（YAT-28 の適応選定）の材料。concept_key/difficulty を非正規化して
-- 持ち、question 削除後も集計できるようにする（ただし FK cascade で通常は問題と連動して消える）。
create table if not exists public.quiz_attempts (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid references public.quiz_questions(id) on delete cascade,
  concept_key  text not null,                       -- 集計軸（question から非正規化）
  difficulty   text not null,                       -- 難易度加重（YAT-28）用に非正規化
  is_correct   boolean not null,
  chosen_index int not null,
  created_at   timestamptz not null default now()
);

-- concept 単位の直近回答の走査（mastery 再計算・履歴表示）。
create index if not exists idx_quiz_attempts_concept
  on public.quiz_attempts (concept_key, created_at desc);

-- ── topic_mastery: concept 単位の習熟マップ（弱点マップの軸）──────────────────
-- concept_key を PK にして表記ゆれを 1 行へ吸収する（F3。正規化は quiz-gate/concept.ts が担う）。
-- MVP は素の正答率（attempts と running ratio）だけを持ち、難易度加重・間隔ボーナスは YAT-28。
create table if not exists public.topic_mastery (
  concept_key    text primary key,                  -- 正規化 slug
  concept_label  text not null,                     -- 表示名
  category       text not null,                     -- tech/* へ集約（表示のグルーピング用）
  mastery        real not null default 0,           -- 0..1 の習熟度（MVP は素の正答率）
  attempts       int not null default 0,            -- 累積回答数
  last_served_at timestamptz,                       -- 直近出題時刻（YAT-28 の間隔ボーナス用）
  updated_at     timestamptz not null default now()
);

-- カテゴリ別の弱点マップ表示（tech/* でグルーピングして mastery 昇順に並べる）。
create index if not exists idx_topic_mastery_category
  on public.topic_mastery (category);

-- ── RLS ──────────────────────────────────────────────
-- 0001 / 0006 / 0007 と同方針。anon/authenticated には SELECT のみ。
-- 書き込み（オンデマンド生成 / 回答記録の Server Action・後続の cron）は service_role が
-- RLS をバイパスするためポリシー不要。
alter table public.quiz_questions enable row level security;
alter table public.quiz_attempts enable row level security;
alter table public.topic_mastery enable row level security;

drop policy if exists "read quiz_questions" on public.quiz_questions;
create policy "read quiz_questions" on public.quiz_questions
  for select to anon, authenticated using (true);

drop policy if exists "read quiz_attempts" on public.quiz_attempts;
create policy "read quiz_attempts" on public.quiz_attempts
  for select to anon, authenticated using (true);

drop policy if exists "read topic_mastery" on public.topic_mastery;
create policy "read topic_mastery" on public.topic_mastery
  for select to anon, authenticated using (true);
