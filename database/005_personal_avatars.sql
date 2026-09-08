-- Keep existing identities intact; NULL selects a stable default in the client.
ALTER TABLE users ADD COLUMN avatar_id text;
ALTER TABLE users ADD CONSTRAINT users_avatar_id_shape
 CHECK (avatar_id IS NULL OR (length(avatar_id)<=64 AND avatar_id ~ '^city-[a-z0-9]+(-[a-z0-9]+)*$'));
