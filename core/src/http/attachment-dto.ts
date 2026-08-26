export function publicAttachment(rec: {
  id: string;
  session_id: string;
  original_name: string;
  mime: string;
  size_bytes: number;
  created_at: string;
}) {
  return {
    id: rec.id,
    session_id: rec.session_id,
    name: rec.original_name,
    mime: rec.mime,
    size_bytes: rec.size_bytes,
    created_at: rec.created_at,
  };
}
