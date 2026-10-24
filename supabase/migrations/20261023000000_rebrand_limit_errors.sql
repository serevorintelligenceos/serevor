-- Brand migration (Nexora -> Serevor): rename the machine-readable prefixes inside the database's trigger functions.
--
--   raise exception 'nexora_limit:<name>'      ->  'serevor_limit:<name>'
--   pg_advisory_xact_lock(hashtextextended('nexora:<scope>:' || ...))  ->  'serevor:<scope>:'
--
-- !! APPLY LAST. Order of rollout:
--   1. Deploy the edge functions that now accept BOTH prefixes (capture-analyze, ask-capture).
--   2. Deploy the new front end (it also accepts both prefixes).
--   3. Apply this migration.
--   4. Later, drop the legacy `nexora_` matches from the client and functions.
-- Applying it before steps 1-2 would make the app stop recognising "daily limit reached" errors (users would see a
-- generic failure instead of the upgrade prompt).
--
-- Idempotent: it rewrites only functions whose source still contains the old prefix, preserving each function's
-- signature, security attributes and trigger bindings (CREATE OR REPLACE keeps triggers attached).
do $$
declare
  r record;
  v_def text;
  v_left int;
begin
  for r in
    select p.oid, p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prosrc ilike '%nexora%'
  loop
    v_def := pg_get_functiondef(r.oid);
    v_def := replace(v_def, 'nexora_limit', 'serevor_limit');
    v_def := replace(v_def, '''nexora:',    '''serevor:');
    execute v_def;
    raise notice 'rewrote %', r.sig;
  end loop;

  select count(*) into v_left
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prosrc ilike '%nexora%';
  if v_left > 0 then
    raise exception 'rebrand incomplete: % function(s) still mention the old name', v_left;
  end if;
end
$$;
