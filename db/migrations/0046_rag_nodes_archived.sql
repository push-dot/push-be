-- Archiving a document, a career evidence item or a saved job removes its search nodes, so agent search
-- (search_career_context) and quick matching stop reading it. A trigger catches every writer (core-api,
-- Python, conversation cleanup) in the archiving transaction. Restoring a job re-ingests it on its next write.
-- Additive and order-free against the code: the code before it reads the same rows.
-- Revert: DROP FUNCTION rag_nodes_drop_archived() CASCADE;  (drops the three triggers with it)

CREATE FUNCTION rag_nodes_drop_archived() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM rag_nodes WHERE source_type = TG_ARGV[0] AND source_id = NEW.id;
    RETURN NEW;
END;
$$;

CREATE TRIGGER rag_nodes_drop_archived
AFTER UPDATE OF status ON documents
FOR EACH ROW WHEN (NEW.status = 'ARCHIVED' AND OLD.status IS DISTINCT FROM 'ARCHIVED')
EXECUTE FUNCTION rag_nodes_drop_archived('document');

CREATE TRIGGER rag_nodes_drop_archived
AFTER UPDATE OF archived ON career_evidence
FOR EACH ROW WHEN (NEW.archived AND OLD.archived IS NOT TRUE)
EXECUTE FUNCTION rag_nodes_drop_archived('evidence');

CREATE TRIGGER rag_nodes_drop_archived
AFTER UPDATE OF archived ON jobs
FOR EACH ROW WHEN (NEW.archived AND OLD.archived IS NOT TRUE)
EXECUTE FUNCTION rag_nodes_drop_archived('job');

-- Nodes already left behind by archiving before this file.
DELETE FROM rag_nodes n USING documents d
    WHERE n.source_type = 'document' AND n.source_id = d.id AND d.status = 'ARCHIVED';
DELETE FROM rag_nodes n USING career_evidence e
    WHERE n.source_type = 'evidence' AND n.source_id = e.id AND e.archived;
DELETE FROM rag_nodes n USING jobs j
    WHERE n.source_type = 'job' AND n.source_id = j.id AND j.archived;

-- Quick matching filters user nodes on document_id; ingest left it NULL on document nodes.
UPDATE rag_nodes SET document_id = source_id
    WHERE source_type = 'document' AND document_id IS NULL;
