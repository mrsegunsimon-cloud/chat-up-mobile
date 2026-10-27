// Sends a push notification to the other people in a chat when a message is inserted.
// Deploy: supabase functions deploy notify
// Then in Supabase: Database > Webhooks > Create: table "messages", event "Insert",
// type "Supabase Edge Functions", function "notify".
import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const { record } = await req.json();
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: members } = await db.from('conversation_members').select('user_id')
    .eq('conversation_id', record.conversation_id).neq('user_id', record.sender_id);
  const allIds = (members ?? []).map((m) => m.user_id);
  const { data: blockers } = await db.from('blocks').select('blocker').eq('blocked', record.sender_id).in('blocker', allIds);
  const skip = new Set((blockers ?? []).map((b) => b.blocker)); // people who blocked the sender get no alert
  const ids = allIds.filter((id) => !skip.has(id));
  if (!ids.length) return new Response('no recipients');
  const [{ data: tokens }, { data: sender }] = await Promise.all([
    db.from('push_tokens').select('token').in('user_id', ids),
    db.from('profiles').select('name, phone').eq('id', record.sender_id).single(),
  ]);
  const who = sender?.name ?? (sender?.phone ? '+' + sender.phone : 'Chat Up');
  const { data: conv } = await db.from('conversations').select('is_group, name').eq('id', record.conversation_id).single();
  const title = conv?.is_group ? `${conv.name}: ${who}` : who;
  // Encrypted text can't be read here, so the alert only says a message arrived.
  const body = record.enc ? 'New message' : (record.body ?? (record.audio_path ? 'Voice note' : 'Photo'));
  const msgs = (tokens ?? []).map((t) => ({ to: t.token, title, body, sound: 'default', data: { conversation_id: record.conversation_id } }));
  if (msgs.length) {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msgs),
    });
  }
  return new Response('ok');
});
