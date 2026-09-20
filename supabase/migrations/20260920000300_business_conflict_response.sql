-- PostgREST can leave explicitly raised SQLSTATE 40001 requests hanging while
-- it treats them like database serialization failures. Business state fences
-- are HTTP conflicts, so expose PT409 while preserving real engine failures.
begin;

do $migration$
declare
  v_function record;
  v_definition text;
  v_expected_count constant integer := 49;
  v_match_count integer;
begin
  select count(*) into v_match_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'conuo_private')
    and p.prokind = 'f'
    and p.prosrc like '%''40001''%';

  if v_match_count <> v_expected_count then
    raise exception using
      errcode = 'P0001',
      message = pg_catalog.format(
        'Expected %s functions with explicit business SQLSTATE 40001, found %s',
        v_expected_count,
        v_match_count
      );
  end if;

  for v_function in
    select p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'conuo_private')
      and p.prokind = 'f'
      and p.prosrc like '%''40001''%'
    order by p.oid
  loop
    v_definition := pg_catalog.pg_get_functiondef(v_function.oid);
    execute pg_catalog.replace(v_definition, '''40001''', '''PT409''');
  end loop;

  select count(*) into v_match_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'conuo_private')
    and p.prokind = 'f'
    and p.prosrc like '%''40001''%';

  if v_match_count <> 0 then
    raise exception using
      errcode = 'P0001',
      message = pg_catalog.format(
        'Business SQLSTATE migration left %s functions unchanged',
        v_match_count
      );
  end if;
end;
$migration$;

commit;
