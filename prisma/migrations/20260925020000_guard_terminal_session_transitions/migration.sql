-- Completed and canceled sessions are terminal. Protect status and schedule
-- fields even when a future route or direct Prisma call bypasses application
-- authorization and transition guards.
CREATE OR REPLACE FUNCTION prevent_terminal_session_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status::text IN ('completed', 'canceled')
    AND (
      NEW.status IS DISTINCT FROM OLD.status
      OR NEW."startAt" IS DISTINCT FROM OLD."startAt"
      OR NEW."endAt" IS DISTINCT FROM OLD."endAt"
    ) THEN
    RAISE EXCEPTION 'Terminal session status and schedule cannot change'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS session_terminal_transition_guard ON "Session";

CREATE TRIGGER session_terminal_transition_guard
BEFORE UPDATE ON "Session"
FOR EACH ROW
EXECUTE FUNCTION prevent_terminal_session_transition();
