-- Transient interaction state belongs to authenticated company presence.
-- Existing table-level runtime grants also cover these new columns.
ALTER TABLE presence
 ADD COLUMN state_updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 ADD COLUMN motion_mode text NOT NULL DEFAULT 'walk' CHECK(motion_mode IN ('walk','run','teleport')),
 ADD COLUMN seat_id text CHECK(seat_id IS NULL OR char_length(seat_id) BETWEEN 1 AND 80),
 ADD COLUMN seat_transform jsonb,
 ADD COLUMN interaction_id uuid,
 ADD COLUMN interaction_type text,
 ADD COLUMN interaction_value text,
 ADD COLUMN interaction_at timestamptz,
 ADD CONSTRAINT presence_seat_pair CHECK((seat_id IS NULL AND seat_transform IS NULL) OR (seat_id IS NOT NULL AND seat_transform IS NOT NULL AND jsonb_typeof(seat_transform)='object')),
 ADD CONSTRAINT presence_interaction_complete CHECK(
  (interaction_id IS NULL AND interaction_type IS NULL AND interaction_value IS NULL AND interaction_at IS NULL)
  OR (interaction_id IS NOT NULL AND interaction_at IS NOT NULL AND interaction_type IS NOT NULL AND interaction_value IS NOT NULL AND
   ((interaction_type='emote' AND interaction_value IN ('wave','dance')) OR
    (interaction_type='reaction' AND interaction_value IN ('wave','applause','heart','idea','celebrate','coffee'))))
 );
UPDATE presence SET state_updated_at=updated_at;
-- Expiring claims are checked under a seat advisory lock, never a time-based unique index.
CREATE INDEX presence_seat_lookup ON presence(company_id,seat_id) WHERE seat_id IS NOT NULL;
