// Deletes statuses older than 24 hours, together with their photo/video files.
// Deploy: supabase functions deploy cleanup-statuses
// It is scheduled hourly by supabase/005_schedule_cleanup.sql.
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async () => {
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const now = new Date().toISOString();
  let removed = 0;
  for (let i = 0; i < 20; i++) { // at most 20 batches of 100 per run; the next run continues
    const { data: rows, error } = await db.from('statuses').select('id, media_path').lt('expires_at', now).limit(100);
    if (error) return new Response(error.message, { status: 500 });
    if (!rows?.length) break;
    const paths = rows.map((r) => r.media_path).filter(Boolean) as string[];
    if (paths.length) {
      const { error: fileError } = await db.storage.from('status-media').remove(paths);
      if (fileError) return new Response(fileError.message, { status: 500 }); // keep the rows so the next run retries
    }
    const { error: deleteError } = await db.from('statuses').delete().in('id', rows.map((r) => r.id));
    if (deleteError) return new Response(deleteError.message, { status: 500 });
    removed += rows.length;
  }
  return new Response(JSON.stringify({ removed }), { headers: { 'Content-Type': 'application/json' } });
});
