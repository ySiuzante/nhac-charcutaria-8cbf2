DO $migration$
DECLARE
  original_definition text := pg_get_functiondef('nhac.dispatch(text,jsonb)'::regprocedure);
  mfa_guard constant text := $guard$  IF admin AND coalesce(auth.jwt()->>'aal','') <> 'aal2' THEN
    RAISE EXCEPTION USING ERRCODE='42501', MESSAGE='Confirme o código do autenticador.';
  END IF;
$guard$;
  updated_definition text;
BEGIN
  updated_definition := replace(original_definition,mfa_guard,'');
  IF length(original_definition)-length(updated_definition)<>length(mfa_guard) THEN
    RAISE EXCEPTION 'A proteção de autenticação esperada não foi encontrada em nhac.dispatch.';
  END IF;
  EXECUTE updated_definition;
END $migration$;
