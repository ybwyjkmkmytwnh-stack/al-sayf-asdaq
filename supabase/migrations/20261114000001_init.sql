-- مخطط أولي يخدم شاشات حقيقية فقط: الحسابات، المحاولات، البلاغات، قرارات المشرف، قصيدة اليوم.
-- طبّقه من Supabase Dashboard ▸ SQL Editor (أو supabase db push). كل الجداول بسياسات RLS مفعّلة.

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text not null default 'trainee' check (role in ('trainee','admin')),
  created_at timestamptz not null default now()
);

-- كل حساب جديد = متدرّب دائمًا. لا يأخذ أحد صلاحية المشرف من المتصفح أو من أول تسجيل.
create function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, role) values (new.id, split_part(new.email,'@',1), 'trainee');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- منع رفع الدور من الواجهة: التغيير يتم فقط من SQL Editor / service_role (auth.uid() فيهما null أو دور الخدمة).
create function public.guard_role_change() returns trigger language plpgsql as $$
begin
  if new.role is distinct from old.role and auth.uid() is not null and auth.role() <> 'service_role' then
    raise exception 'role change not allowed from client';
  end if;
  return new;
end $$;
create trigger profiles_guard_role before update on public.profiles for each row execute function public.guard_role_change();

create table public.attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_attempt_id uuid not null,                       -- يمنع التكرار عند إعادة المحاولة بعد فشل الشبكة
  poem_id text not null,
  hem_id text not null,                                  -- معرّف مستقر للشطر (لا يتغيّر بتصحيح التوقيت)
  hem_index int,
  mode text,
  overall numeric, pitch_score numeric, timing_score numeric,
  heard_text text, words_verdict text, words_json jsonb,  -- نتائج الكلمات (قد تكون null إن توقف التعرّف)
  read_counted boolean not null default false,
  measurable boolean not null default true,              -- false ⇒ لا تدخل «أخطائي»
  app_version text, scoring_engine text, speech_engine text,
  created_at timestamptz not null default now(),
  unique (user_id, client_attempt_id)
);
create index attempts_user_time on public.attempts (user_id, created_at desc);
create index attempts_hem on public.attempts (poem_id, hem_id);

create table public.reports (                              -- «التطبيق قيّمني غلط»
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  attempt_id uuid references public.attempts(id) on delete set null,
  client_report_id uuid not null,
  poem_id text, hem_id text, word_index int,
  reason text not null, shown_result jsonb,
  share_clip_path text,                                   -- يُملأ فقط بموافقة صريحة على مشاركة المقطع
  app_version text, scoring_engine text,
  status text not null default 'new' check (status in ('new','confirmed_pronunciation','timing_error','recognition_error','false_negative','undecided')),
  admin_note text, decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, client_report_id)
);

create table public.review_decisions (                     -- سجلّ قرارات المشرف (للرجوع والتدقيق)
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.reports(id) on delete set null,
  decided_by uuid not null default auth.uid() references auth.users(id),
  decision text not null, detail jsonb, reverts_id uuid references public.review_decisions(id),
  created_at timestamptz not null default now()
);

create table public.daily_poems (                          -- اختيار قصيدة ليوم بتوقيت الرياض
  day date primary key, poem_id text not null, created_by uuid default auth.uid()
);

alter table public.profiles enable row level security;
alter table public.attempts enable row level security;
alter table public.reports enable row level security;
alter table public.review_decisions enable row level security;
alter table public.daily_poems enable row level security;

create policy profiles_read_own on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy profiles_update_own on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy attempts_select on public.attempts for select using (user_id = auth.uid() or public.is_admin());
create policy attempts_insert on public.attempts for insert with check (user_id = auth.uid());
create policy attempts_delete_own on public.attempts for delete using (user_id = auth.uid());

create policy reports_select on public.reports for select using (user_id = auth.uid() or public.is_admin());
create policy reports_insert on public.reports for insert with check (user_id = auth.uid() and status = 'new');
create policy reports_admin_update on public.reports for update using (public.is_admin()) with check (public.is_admin());

create policy decisions_admin on public.review_decisions for all using (public.is_admin()) with check (public.is_admin());
create policy daily_read on public.daily_poems for select using (true);
create policy daily_admin_write on public.daily_poems for all using (public.is_admin()) with check (public.is_admin());

-- مقاطع خاصة: الملف يُحفظ تحت {uid}/... ولا يقرؤه غير صاحبه، أو المشرف إن كان مرتبطًا ببلاغ شارك صاحبه مقطعه.
insert into storage.buckets (id, name, public) values ('clips','clips', false) on conflict (id) do nothing;
create policy clips_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'clips' and (storage.foldername(name))[1] = auth.uid()::text);
create policy clips_select_own on storage.objects for select to authenticated
  using (bucket_id = 'clips' and (storage.foldername(name))[1] = auth.uid()::text);
create policy clips_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'clips' and (storage.foldername(name))[1] = auth.uid()::text);
create policy clips_admin_shared on storage.objects for select to authenticated
  using (bucket_id = 'clips' and public.is_admin() and exists (select 1 from public.reports r where r.share_clip_path = storage.objects.name));

-- لتعيين نفسك مشرفًا (مرة واحدة، بعد أول دخول بالموقع) نفّذ من SQL Editor:
--   update public.profiles set role = 'admin' where id = (select id from auth.users where email = 'بريدك@example.com');
