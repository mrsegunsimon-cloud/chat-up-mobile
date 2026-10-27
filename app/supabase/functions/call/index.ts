// Starts or joins a one-to-one call and hands back a LiveKit room pass.
// Deploy: supabase functions deploy call
// Secrets (Supabase dashboard > Edge Functions > Secrets, never in the app):
//   LIVEKIT_URL (wss://your-project.livekit.cloud), LIVEKIT_API_KEY, LIVEKIT_API_SECRET
// Request body: { action: 'start', conversation_id, kind: 'voice'|'video', key_box } (key_box = the call key locked for the other phone; see 010_call_encryption.sql) or { action: 'join', call_id }
import { createClient } from 'npm:@supabase/supabase-js@2';
import { AccessToken } from 'npm:livekit-server-sdk@2';

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  // Acts as the signed-in person, so the database rules in 009_calls.sql decide what is allowed.
  const user = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: auth } } });
  const { data: u } = await user.auth.getUser();
  if (!u?.user) return json({ error: 'Not signed in' }, 401);
  const body = await req.json();
  let call;
  if (body.action === 'start') {
    const r = await user.rpc('start_call', { cid: body.conversation_id, call_kind: body.kind, call_key_box: body.key_box });
    if (r.error) return json({ error: r.error.message }, 400);
    call = r.data;
    // Ring the other phone. Skipped if they blocked the caller (start_call already refuses that).
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const [{ data: tokens }, { data: me }] = await Promise.all([
      admin.from('push_tokens').select('token').eq('user_id', call.callee),
      admin.from('profiles').select('name, phone').eq('id', u.user.id).single(),
    ]);
    const who = me?.name ?? (me?.phone ? '+' + me.phone : 'Chat Up');
    const msgs = (tokens ?? []).map((t) => ({ to: t.token, title: who, body: `Incoming ${call.kind} call`, sound: 'default', priority: 'high', channelId: 'calls', data: { type: 'call', call_id: call.id, kind: call.kind } }));
    if (msgs.length) await fetch('https://exp.host/--/api/v2/push/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msgs) });
  } else if (body.action === 'join') {
    const r = await user.from('calls').select('*').eq('id', body.call_id).single();
    if (r.error || !r.data) return json({ error: 'Call not found' }, 404);
    call = r.data;
    if (call.status === 'ringing' && call.callee === u.user.id) {
      const a = await user.rpc('update_call', { call_id: call.id, new_status: 'answered' });
      if (a.error) return json({ error: a.error.message }, 400);
      call = a.data;
    }
    if (!['ringing', 'answered'].includes(call.status)) return json({ error: 'This call has ended' }, 410);
  } else return json({ error: 'Unknown action' }, 400);

  // Pass is valid 2 hours, only for this call's room, and only for this person.
  const at = new AccessToken(Deno.env.get('LIVEKIT_API_KEY')!, Deno.env.get('LIVEKIT_API_SECRET')!, { identity: u.user.id, ttl: '2h' });
  at.addGrant({ roomJoin: true, room: call.id, canPublish: true, canSubscribe: true });
  return json({ call, url: Deno.env.get('LIVEKIT_URL'), token: await at.toJwt() });
});
