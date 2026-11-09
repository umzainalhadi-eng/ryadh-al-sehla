create table if not exists public.classroom_teachers (
    user_id uuid primary key references auth.users (id) on delete cascade,
    created_at timestamptz not null default now()
);

create table if not exists public.classroom_student_access (
    student_id uuid primary key references auth.users (id) on delete cascade,
    student_name text not null check (char_length(trim(student_name)) between 2 and 80),
    class_name text not null check (char_length(trim(class_name)) between 1 and 120),
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
    requested_at timestamptz not null default now(),
    reviewed_at timestamptz,
    reviewed_by uuid references auth.users (id) on delete set null
);

create table if not exists public.platform_content (
    id text primary key check (char_length(id) between 1 and 120),
    kind text not null check (kind in ('game', 'story', 'film', 'section', 'appearance')),
    title text not null check (char_length(title) between 1 and 160),
    category text not null default '' check (char_length(category) <= 120),
    payload jsonb not null default '{}'::jsonb,
    sort_order integer not null default 0,
    updated_by uuid references auth.users (id) on delete set null,
    updated_at timestamptz not null default now()
);

create table if not exists public.platform_teacher_profile (
    id text primary key check (id = 'main'),
    display_name text not null check (display_name in ('أ. علي', 'أ. مؤمن', 'أ. محمد', 'أ. فهد', 'أ. سلطان')),
    updated_by uuid not null references auth.users (id) on delete cascade,
    updated_at timestamptz not null default now()
);

create table if not exists public.classroom_threads (
    id uuid primary key default gen_random_uuid(),
    student_id uuid not null references auth.users (id) on delete cascade,
    student_name text not null check (char_length(student_name) between 1 and 80),
    class_name text not null default '',
    kind text not null check (kind in ('submission', 'question', 'chat')),
    title text not null check (char_length(title) between 1 and 160),
    created_at timestamptz not null default now()
);

create table if not exists public.classroom_messages (
    id uuid primary key default gen_random_uuid(),
    thread_id uuid not null references public.classroom_threads (id) on delete cascade,
    sender_id uuid not null references auth.users (id) on delete cascade,
    sender_role text not null check (sender_role in ('student', 'teacher')),
    body text not null check (char_length(body) between 1 and 5000),
    answers jsonb not null default '[]'::jsonb,
    score jsonb,
    created_at timestamptz not null default now()
);

create table if not exists public.classroom_reactions (
    message_id uuid primary key references public.classroom_messages (id) on delete cascade,
    teacher_id uuid not null references auth.users (id) on delete cascade,
    reaction text not null check (reaction in ('❤️', '👏', '⭐', '💡')),
    updated_at timestamptz not null default now()
);

create index if not exists classroom_threads_student_created_idx
    on public.classroom_threads (student_id, created_at desc);
create index if not exists classroom_messages_thread_created_idx
    on public.classroom_messages (thread_id, created_at);

alter table public.classroom_teachers enable row level security;
alter table public.classroom_student_access enable row level security;
alter table public.platform_content enable row level security;
alter table public.platform_teacher_profile enable row level security;
alter table public.classroom_threads enable row level security;
alter table public.classroom_messages enable row level security;
alter table public.classroom_reactions enable row level security;

create or replace function public.is_classroom_teacher()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.classroom_teachers
        where user_id = (select auth.uid())
    );
$$;

revoke all on function public.is_classroom_teacher() from public;
grant execute on function public.is_classroom_teacher() to authenticated;

create or replace function public.is_classroom_student_approved()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select (select public.is_classroom_teacher())
        or exists (
            select 1
            from public.classroom_student_access
            where student_id = (select auth.uid())
              and status = 'approved'
        );
$$;

revoke all on function public.is_classroom_student_approved() from public;
grant execute on function public.is_classroom_student_approved() to authenticated;

create or replace function public.request_student_access(p_student_name text, p_class_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    requested_status text;
begin
    if (select auth.uid()) is null
       or (select auth.jwt()) ->> 'is_anonymous' = 'true'
       or (select public.is_classroom_teacher()) then
        raise exception 'يلزم حساب طالب مسجل لطلب الموافقة.';
    end if;
    if char_length(trim(coalesce(p_student_name, ''))) not between 2 and 80
       or char_length(trim(coalesce(p_class_name, ''))) not between 1 and 120 then
        raise exception 'تحقق من الاسم والصف قبل إرسال الطلب.';
    end if;

    insert into public.classroom_student_access (student_id, student_name, class_name, status, requested_at, reviewed_at, reviewed_by)
    values ((select auth.uid()), trim(p_student_name), trim(p_class_name), 'pending', now(), null, null)
    on conflict (student_id) do update
        set student_name = excluded.student_name,
            class_name = excluded.class_name,
            status = 'pending',
            requested_at = now(),
            reviewed_at = null,
            reviewed_by = null
    returning status into requested_status;

    return requested_status;
end;
$$;

revoke all on function public.request_student_access(text, text) from public, anon;
grant execute on function public.request_student_access(text, text) to authenticated;

create or replace function public.review_student_access(p_student_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
    if not (select public.is_classroom_teacher()) then
        raise exception 'يلزم حساب معلم معتمد لمراجعة الطلبات.';
    end if;
    if p_status not in ('approved', 'rejected') then
        raise exception 'حالة الموافقة غير صالحة.';
    end if;

    update public.classroom_student_access
       set status = p_status,
           reviewed_at = now(),
           reviewed_by = (select auth.uid())
     where student_id = p_student_id
       and status = 'pending';
    if not found then
        raise exception 'طلب الطالب غير موجود أو تمت مراجعته مسبقاً.';
    end if;
end;
$$;

revoke all on function public.review_student_access(uuid, text) from public, anon;
grant execute on function public.review_student_access(uuid, text) to authenticated;

drop policy if exists "students and teachers read permitted threads" on public.classroom_threads;
drop policy if exists "students create their own threads" on public.classroom_threads;
drop policy if exists "teachers read messages" on public.classroom_messages;
drop policy if exists "thread participants send messages" on public.classroom_messages;
drop policy if exists "students and teachers read permitted reactions" on public.classroom_reactions;
drop policy if exists "teachers manage reactions" on public.classroom_reactions;
drop policy if exists "students read own access request" on public.classroom_student_access;
drop policy if exists "teachers read student access requests" on public.classroom_student_access;
drop policy if exists "teachers review student access requests" on public.classroom_student_access;
drop policy if exists "everyone reads published platform content" on public.platform_content;
drop policy if exists "approved users read published platform content" on public.platform_content;
drop policy if exists "teachers manage platform content" on public.platform_content;
drop policy if exists "everyone reads teacher display name" on public.platform_teacher_profile;
drop policy if exists "teachers manage teacher display name" on public.platform_teacher_profile;

create policy "approved users read published platform content"
    on public.platform_content for select to authenticated
    using ((select public.is_classroom_student_approved()));

create policy "teachers manage platform content"
    on public.platform_content for all to authenticated
    using ((select public.is_classroom_teacher()))
    with check ((select public.is_classroom_teacher()));

create policy "everyone reads teacher display name"
    on public.platform_teacher_profile for select to anon, authenticated
    using (true);

create policy "teachers manage teacher display name"
    on public.platform_teacher_profile for all to authenticated
    using ((select public.is_classroom_teacher()))
    with check (
        (select public.is_classroom_teacher())
        and updated_by = (select auth.uid())
    );

create policy "students read own access request"
    on public.classroom_student_access for select to authenticated
    using (student_id = (select auth.uid()));

create policy "teachers read student access requests"
    on public.classroom_student_access for select to authenticated
    using ((select public.is_classroom_teacher()));

create policy "teachers review student access requests"
    on public.classroom_student_access for update to authenticated
    using ((select public.is_classroom_teacher()) and status = 'pending')
    with check ((select public.is_classroom_teacher()));

create policy "students and teachers read permitted threads"
    on public.classroom_threads for select to authenticated
    using (
        (select public.is_classroom_teacher())
        or (
            (select public.is_classroom_student_approved())
            and (select auth.uid()) = student_id
        )
    );

create policy "students create their own threads"
    on public.classroom_threads for insert to authenticated
    with check (
        (select auth.uid()) = student_id
        and not (select public.is_classroom_teacher())
        and (select public.is_classroom_student_approved())
    );

create policy "teachers read messages"
    on public.classroom_messages for select to authenticated
    using (
        (select public.is_classroom_teacher())
        or (
            (select public.is_classroom_student_approved())
            and exists (
                select 1
                from public.classroom_threads
                where classroom_threads.id = classroom_messages.thread_id
                  and classroom_threads.student_id = (select auth.uid())
            )
        )
    );

create policy "thread participants send messages"
    on public.classroom_messages for insert to authenticated
    with check (
        sender_id = (select auth.uid())
        and (
            (
                sender_role = 'student'
                and not (select public.is_classroom_teacher())
                and (select public.is_classroom_student_approved())
                and exists (
                    select 1
                    from public.classroom_threads
                    where classroom_threads.id = classroom_messages.thread_id
                      and classroom_threads.student_id = (select auth.uid())
                )
            )
            or (
                sender_role = 'teacher'
                and (select public.is_classroom_teacher())
                and exists (
                    select 1
                    from public.classroom_threads
                    where classroom_threads.id = classroom_messages.thread_id
                )
            )
        )
    );

create policy "students and teachers read permitted reactions"
    on public.classroom_reactions for select to authenticated
    using (
        (select public.is_classroom_teacher())
        or (
            (select public.is_classroom_student_approved())
            and exists (
                select 1
                from public.classroom_messages
                join public.classroom_threads
                  on classroom_threads.id = classroom_messages.thread_id
                where classroom_messages.id = classroom_reactions.message_id
                  and classroom_threads.student_id = (select auth.uid())
            )
        )
    );

create policy "teachers manage reactions"
    on public.classroom_reactions for all to authenticated
    using (
        (select public.is_classroom_teacher())
        and teacher_id = (select auth.uid())
    )
    with check (
        (select public.is_classroom_teacher())
        and teacher_id = (select auth.uid())
    );

create or replace function public.create_classroom_thread(
    p_student_name text,
    p_class_name text,
    p_kind text,
    p_title text,
    p_body text,
    p_answers jsonb default '[]'::jsonb,
    p_score jsonb default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
    new_thread_id uuid;
begin
    insert into public.classroom_threads (
        student_id, student_name, class_name, kind, title
    ) values (
        (select auth.uid()),
        left(trim(p_student_name), 80),
        left(trim(coalesce(p_class_name, '')), 120),
        p_kind,
        left(trim(p_title), 160)
    )
    returning id into new_thread_id;

    insert into public.classroom_messages (
        thread_id, sender_id, sender_role, body, answers, score
    ) values (
        new_thread_id,
        (select auth.uid()),
        'student',
        left(trim(p_body), 5000),
        coalesce(p_answers, '[]'::jsonb),
        p_score
    );

    return new_thread_id;
end;
$$;

revoke all on function public.create_classroom_thread(
    text, text, text, text, text, jsonb, jsonb
) from public, anon;
grant execute on function public.create_classroom_thread(
    text, text, text, text, text, jsonb, jsonb
) to authenticated;

revoke all on public.classroom_teachers from anon, authenticated;
revoke all on public.classroom_student_access from anon, authenticated;
revoke all on public.platform_content from anon, authenticated;
revoke all on public.platform_teacher_profile from anon, authenticated;
grant select on public.platform_content to authenticated;
grant insert, update, delete on public.platform_content to authenticated;
grant select on public.platform_teacher_profile to anon, authenticated;
grant insert, update, delete on public.platform_teacher_profile to authenticated;
grant select on public.classroom_threads to authenticated;
grant insert on public.classroom_threads to authenticated;
grant select, insert on public.classroom_messages to authenticated;
grant select, insert, update, delete on public.classroom_reactions to authenticated;
grant select, update on public.classroom_student_access to authenticated;

-- Create teacher accounts in Supabase Auth first, then run this as the project owner:
-- insert into public.classroom_teachers (user_id)
-- select id from auth.users where email = 'teacher@example.com'
-- on conflict (user_id) do nothing;
