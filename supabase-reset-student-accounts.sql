begin;

-- This one-time cleanup removes legacy anonymous student accounts and their
-- dependent rows. Accounts registered to classroom_teachers are preserved.
delete from auth.users as users
where users.is_anonymous
  and not exists (
      select 1
      from public.classroom_teachers as teachers
      where teachers.user_id = users.id
  );

commit;
