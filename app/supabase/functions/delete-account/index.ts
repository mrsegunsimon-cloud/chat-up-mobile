// Deletes the signed-in person's account for good. The app calls leave_all_groups() first.
// Deploy: supabase functions deploy delete-account
// Removes the person's status files, then their login. Database rows follow through cascade rules:
// profile, statuses, views, blocks, push tokens and memberships are deleted; their sent messages stay in other
// people's chats and show as "Deleted account". Photos and voice notes they sent in chats are NOT deleted here.
// Decide with your lawyer whether chat files must also be erased in your country.
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL')!;
  const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: { user }, error } = await asUser.auth.getUser();
  if (error || !user) return new Response('Not signed in', { status: 401 });

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  for (let i = 0; i < 50; i++) { // up to 5,000 files
    const { data: files } = await admin.storage.from('status-media').list(user.id, { limit: 100 });
    if (!files?.length) break;
    await admin.storage.from('status-media').remove(files.map((f) => `${user.id}/${f.name}`));
  }
  const { error: delError } = await admin.auth.admin.deleteUser(user.id);
  if (delError) return new Response(delError.message, { status: 500 });
  return new Response('ok');
});
