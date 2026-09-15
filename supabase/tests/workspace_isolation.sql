-- Run only against an isolated local Supabase test database after migration.
-- Entire fixture is rolled back. This is not run automatically against production.
begin;

insert into auth.users (id, email)
values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'conuo-test-a@example.invalid'),
       ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'conuo-test-b@example.invalid');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);

do $$
declare
  v_data jsonb := '{"schemaVersion":1,"spaces":[{"id":"library","name":"Library","goal":"","color":"blue","archived":false,"createdAt":"2026-09-12T00:00:00.000Z"}],"sources":[],"notes":[{"id":"note-a","spaceId":"library","title":"Owner note","content":"Private learning note","kind":"note","status":"draft","citations":[],"versions":[],"createdAt":"2026-09-12T00:00:00.000Z","updatedAt":"2026-09-12T00:00:00.000Z","deletedAt":null}],"annotations":[],"conversations":[],"aiEnabled":false}';
begin
  if public.save_workspace(v_data, 0) <> 1 then raise exception 'First revision incorrect'; end if;
  if public.save_workspace(v_data, 1) <> 2 then raise exception 'Revision increment incorrect'; end if;
  if not exists (select 1 from public.notes where note_id = 'note-a') then
    raise exception 'Owner could not read projected note';
  end if;
  begin
    update public.notes set title = 'forged' where note_id = 'note-a';
    raise exception 'Direct projected note write bypassed snapshot authority';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.save_workspace(v_data, 1);
    raise exception 'Stale revision was accepted';
  exception when serialization_failure then null;
  end;
  begin
    perform public.save_workspace(v_data, 0);
    raise exception 'Existing workspace was overwritten by initial save';
  exception when serialization_failure then null;
  end;
  begin
    update public.workspaces set revision = 999;
    raise exception 'Direct write bypassed CAS';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
do $$
declare
  v_data jsonb := '{"schemaVersion":1,"spaces":[],"sources":[],"notes":[],"annotations":[],"conversations":[],"aiEnabled":false}';
begin
  if exists (select 1 from public.workspaces) then raise exception 'Cross-account SELECT leaked workspace'; end if;
  if exists (select 1 from public.notes) then raise exception 'Cross-account SELECT leaked projected note'; end if;
  begin
    perform public.save_workspace(v_data, 2);
    raise exception 'Cross-account revision was modified';
  exception when serialization_failure then null;
  end;
  if public.save_workspace(v_data, 0) <> 1 then raise exception 'Independent workspace creation failed'; end if;
  if (select count(*) from public.workspaces) <> 1 then raise exception 'Unexpected visible workspace count'; end if;
end;
$$;

reset role;
rollback;
