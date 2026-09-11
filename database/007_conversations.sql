-- Durable, commit-ordered conversation streams. Existing message IDs and text are preserved.
ALTER TABLE agents ADD COLUMN conversation_access text NOT NULL DEFAULT 'none' CHECK(conversation_access IN ('none','read','write'));
CREATE TABLE conversations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 room_id uuid, last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(company_id,id), FOREIGN KEY(company_id,room_id) REFERENCES rooms(company_id,id)
);
CREATE UNIQUE INDEX conversations_channel_idx ON conversations(company_id,COALESCE(room_id,'00000000-0000-0000-0000-000000000000'::uuid));
INSERT INTO conversations(company_id) SELECT id FROM companies;
INSERT INTO conversations(company_id,room_id) SELECT company_id,id FROM rooms;

ALTER TABLE messages ADD COLUMN conversation_id uuid;
ALTER TABLE messages ADD COLUMN sequence bigint;
ALTER TABLE messages ADD COLUMN last_event_sequence bigint;
ALTER TABLE messages ADD COLUMN parent_id uuid;
ALTER TABLE messages ADD COLUMN client_id uuid;
ALTER TABLE messages ADD COLUMN actor_kind text NOT NULL DEFAULT 'human' CHECK(actor_kind IN ('human','agent'));
ALTER TABLE messages ADD COLUMN agent_id uuid;
ALTER TABLE messages ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE messages ADD COLUMN edited_at timestamptz;
ALTER TABLE messages ADD COLUMN deleted_at timestamptz;
ALTER TABLE messages ALTER COLUMN user_id DROP NOT NULL;
UPDATE messages m SET conversation_id=c.id FROM conversations c WHERE c.company_id=m.company_id AND c.room_id IS NOT DISTINCT FROM m.room_id;
WITH ranked AS (SELECT id,row_number() OVER(PARTITION BY conversation_id ORDER BY created_at,id) AS seq FROM messages)
 UPDATE messages m SET sequence=r.seq,last_event_sequence=r.seq FROM ranked r WHERE r.id=m.id;
UPDATE conversations c SET last_sequence=COALESCE((SELECT max(sequence) FROM messages WHERE conversation_id=c.id),0);
ALTER TABLE messages ALTER COLUMN conversation_id SET NOT NULL;
ALTER TABLE messages ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE messages ALTER COLUMN last_event_sequence SET NOT NULL;
ALTER TABLE messages ADD CONSTRAINT messages_conversation_fk FOREIGN KEY(company_id,conversation_id) REFERENCES conversations(company_id,id) ON DELETE CASCADE;
ALTER TABLE messages ADD CONSTRAINT messages_agent_fk FOREIGN KEY(company_id,agent_id) REFERENCES agents(company_id,id);
ALTER TABLE messages ADD CONSTRAINT messages_actor_check CHECK((actor_kind='human' AND user_id IS NOT NULL AND agent_id IS NULL) OR (actor_kind='agent' AND user_id IS NULL AND agent_id IS NOT NULL));
ALTER TABLE messages ADD CONSTRAINT messages_conversation_identity UNIQUE(company_id,conversation_id,id);
ALTER TABLE messages ADD CONSTRAINT messages_parent_fk FOREIGN KEY(company_id,conversation_id,parent_id) REFERENCES messages(company_id,conversation_id,id);
ALTER TABLE messages ADD CONSTRAINT messages_parent_self_check CHECK(parent_id IS NULL OR parent_id<>id);
ALTER TABLE messages ADD CONSTRAINT messages_sequence_check CHECK(sequence>0 AND last_event_sequence>=sequence);
ALTER TABLE messages DROP CONSTRAINT messages_body_check;
ALTER TABLE messages ADD CONSTRAINT messages_body_check CHECK((deleted_at IS NULL AND length(body) BETWEEN 1 AND 4000) OR (deleted_at IS NOT NULL AND body=''));
CREATE UNIQUE INDEX messages_conversation_sequence_idx ON messages(conversation_id,sequence);
CREATE INDEX messages_thread_sequence_idx ON messages(conversation_id,parent_id,sequence DESC);

CREATE TABLE conversation_events (
 company_id uuid NOT NULL, conversation_id uuid NOT NULL, sequence bigint NOT NULL CHECK(sequence>0),
 kind text NOT NULL CHECK(kind IN ('message.created','message.edited','message.deleted','reaction.changed','read.updated')),
 message_id uuid, actor_kind text NOT NULL CHECK(actor_kind IN ('human','agent')), actor_id uuid NOT NULL,
 read_sequence bigint, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(conversation_id,sequence),
 FOREIGN KEY(company_id,conversation_id) REFERENCES conversations(company_id,id) ON DELETE CASCADE,
 FOREIGN KEY(company_id,conversation_id,message_id) REFERENCES messages(company_id,conversation_id,id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 CHECK((kind='read.updated' AND message_id IS NULL AND read_sequence IS NOT NULL AND read_sequence>=0) OR (kind<>'read.updated' AND message_id IS NOT NULL AND read_sequence IS NULL))
);
INSERT INTO conversation_events(company_id,conversation_id,sequence,kind,message_id,actor_kind,actor_id,created_at)
 SELECT company_id,conversation_id,sequence,'message.created',id,'human',user_id,created_at FROM messages;

CREATE TABLE conversation_reads (
 company_id uuid NOT NULL, conversation_id uuid NOT NULL, actor_kind text NOT NULL CHECK(actor_kind IN ('human','agent')), actor_id uuid NOT NULL,
 sequence bigint NOT NULL DEFAULT 0 CHECK(sequence>=0), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(conversation_id,actor_kind,actor_id), FOREIGN KEY(company_id,conversation_id) REFERENCES conversations(company_id,id) ON DELETE CASCADE
);
CREATE TABLE message_reactions (
 company_id uuid NOT NULL, conversation_id uuid NOT NULL, message_id uuid NOT NULL,
 actor_kind text NOT NULL CHECK(actor_kind IN ('human','agent')), actor_id uuid NOT NULL,
 emoji text NOT NULL CHECK(emoji IN ('thumbsup','heart','applause','laugh','idea','celebrate')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(message_id,actor_kind,actor_id,emoji),
 FOREIGN KEY(company_id,conversation_id,message_id) REFERENCES messages(company_id,conversation_id,id) ON DELETE CASCADE
);
CREATE TABLE conversation_requests (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 actor_kind text NOT NULL CHECK(actor_kind IN ('human','agent')), actor_id uuid NOT NULL, client_id uuid NOT NULL,
 payload_hash text NOT NULL CHECK(length(payload_hash)=64), conversation_id uuid NOT NULL, message_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(company_id,actor_kind,actor_id,client_id),
 FOREIGN KEY(company_id,conversation_id,message_id) REFERENCES messages(company_id,conversation_id,id) ON DELETE CASCADE
);

-- Keep the previous deployed writer working during rollout and rollback. Its
-- INSERT omits conversation_id. The deferred FK allows the event to be written
-- before that original message row is inserted, atomically in the same transaction.
CREATE FUNCTION coatria_legacy_message_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.conversation_id IS NOT NULL THEN RETURN NEW; END IF;
 INSERT INTO public.conversations(company_id,room_id) VALUES(NEW.company_id,NEW.room_id) ON CONFLICT DO NOTHING;
 UPDATE public.conversations SET last_sequence=last_sequence+1
  WHERE company_id=NEW.company_id AND room_id IS NOT DISTINCT FROM NEW.room_id
  RETURNING id,last_sequence INTO NEW.conversation_id,NEW.sequence;
 NEW.last_event_sequence:=NEW.sequence;
 INSERT INTO public.conversation_events(company_id,conversation_id,sequence,kind,message_id,actor_kind,actor_id,created_at)
  VALUES(NEW.company_id,NEW.conversation_id,NEW.sequence,'message.created',NEW.id,NEW.actor_kind,COALESCE(NEW.user_id,NEW.agent_id),NEW.created_at);
 RETURN NEW;
END;
$$;
CREATE TRIGGER coatria_legacy_message_insert BEFORE INSERT ON messages
 FOR EACH ROW EXECUTE FUNCTION coatria_legacy_message_insert();
