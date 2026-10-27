const SUPABASE_URL = 'PASTE_PROJECT_URL_HERE';
const SUPABASE_KEY = 'PASTE_PUBLISHABLE_KEY_HERE';
import 'react-native-get-random-values';
import 'react-native-url-polyfill/auto';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, FlatList, Pressable, Image, SafeAreaView, Alert, StyleSheet, Animated, KeyboardAvoidingView, Modal, PanResponder, Platform, ScrollView, StatusBar, Switch, useColorScheme, useWindowDimensions, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { createClient } from '@supabase/supabase-js';
import { Audio } from 'expo-av';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import * as ScreenCapture from 'expo-screen-capture';
import { VideoView, useVideoPlayer } from 'expo-video';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import * as MediaLibrary from 'expo-media-library';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';
import nacl from 'tweetnacl';
import { scrypt } from 'scrypt-js';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';

Notifications.setNotificationHandler({ handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: false }) });

// Saves this phone's push token so the server can notify it. Fails quietly in Expo Go / Snack, where remote push is unavailable.
async function registerPush(userId) {
  try {
    if (!Device.isDevice) return;
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', { name: 'Messages', importance: Notifications.AndroidImportance.HIGH });
      await Notifications.setNotificationChannelAsync('calls', { name: 'Calls', importance: Notifications.AndroidImportance.MAX, vibrationPattern: [0, 500, 300, 500] });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== 'granted') return;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    await supabase.from('push_tokens').upsert({ user_id: userId, token: data });
  } catch (e) { console.log('Push not set up:', e.message); }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
});
const fail = (e) => Alert.alert('Something went wrong', e.message);

// Blocks screen recording while `on` is true: always on Android, and on iPhone for recordings (and screenshots on iOS 13+).
// It cannot stop someone filming a screen with another device, so describe it to users as protection, not a guarantee.
function useScreenProtection(on, key = 'chatup') {
  useEffect(() => {
    if (!on) return;
    ScreenCapture.preventScreenCaptureAsync(key).catch(() => {});
    return () => { ScreenCapture.allowScreenCaptureAsync(key).catch(() => {}); };
  }, [on, key]);
}

// LiveKit is native code: it works in a development build, not in Expo Go or Snack. Without it, calls show a clear message.
let LK = null;
try { LK = require('@livekit/react-native'); LK.registerGlobals(); } catch (e) { LK = null; }
let LKC = null;
try { LKC = require('livekit-client'); } catch (e) { LKC = null; }

// Calls the `call` Edge Function. Returns { call, url, token } or throws a readable error.
async function callApi(body) {
  const { data, error } = await supabase.functions.invoke('call', { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// ---- End-to-end encryption for calls ----
// Each phone keeps a private key in secure storage and publishes only its public key. The caller makes a random
// call key and locks it for the other phone. The server only ever sees the locked copy.
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
async function myKeys() {
  let sk = await SecureStore.getItemAsync('chatup.nacl.secret');
  if (!sk) {
    const kp = nacl.box.keyPair();
    sk = encodeBase64(kp.secretKey);
    await SecureStore.setItemAsync('chatup.nacl.secret', sk);
  }
  return nacl.box.keyPair.fromSecretKey(decodeBase64(sk));
}
async function publishKey() {
  try {
    const kp = await myKeys();
    const { error } = await supabase.rpc('set_public_key', { k: encodeBase64(kp.publicKey) });
    if (error) console.log('Public key not saved:', error.message);
  } catch (e) { console.log('Key setup failed:', e.message); }
}
const lockCallKey = (callKey, theirPub, mySecret) => {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  return encodeBase64(cat(nonce, nacl.box(callKey, nonce, theirPub, mySecret)));
};
const openCallKey = (b64, theirPub, mySecret) => {
  const all = decodeBase64(b64);
  return nacl.box.open(all.slice(nacl.box.nonceLength), all.slice(0, nacl.box.nonceLength), theirPub, mySecret);
};
// Encrypted text for one-to-one chats: the same shared secret locks and unlocks, so both people can read it.
const encText = (text, theirPub, mySecret) => {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  return encodeBase64(cat(nonce, nacl.box(decodeUTF8(text), nonce, theirPub, mySecret)));
};
const decText = (b64, theirPub, mySecret) => {
  try {
    const all = decodeBase64(b64);
    const out = nacl.box.open(all.slice(nacl.box.nonceLength), all.slice(0, nacl.box.nonceLength), theirPub, mySecret);
    return out ? encodeUTF8(out) : null;
  } catch (e) { return null; }
};
// Group messages: one random content key per message, locked separately for every member.
const lockForMembers = (text, memberPubs, mySecret) => {
  const ck = nacl.randomBytes(nacl.secretbox.keyLength);
  const n = nacl.randomBytes(nacl.secretbox.nonceLength);
  const enc = encodeBase64(cat(n, nacl.secretbox(decodeUTF8(text), n, ck)));
  const keys = {};
  Object.entries(memberPubs).forEach(([id, pub]) => {
    const kn = nacl.randomBytes(nacl.box.nonceLength);
    keys[id] = encodeBase64(cat(kn, nacl.box(ck, kn, pub, mySecret)));
  });
  return { enc, enc_keys: keys };
};
const unlockFromSender = (enc, keyBox, senderPub, mySecret) => {
  try {
    if (!enc || !keyBox || !senderPub) return null;
    const kb = decodeBase64(keyBox);
    const ck = nacl.box.open(kb.slice(nacl.box.nonceLength), kb.slice(0, nacl.box.nonceLength), senderPub, mySecret);
    if (!ck) return null;
    const all = decodeBase64(enc);
    const out = nacl.secretbox.open(all.slice(nacl.secretbox.nonceLength), all.slice(0, nacl.secretbox.nonceLength), ck);
    return out ? encodeUTF8(out) : null;
  } catch (e) { return null; }
};
// Photos and voice notes: each file gets its own random key and is locked before upload.
const lockFile = (bytes) => {
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  return { key: encodeBase64(key), data: cat(nonce, nacl.secretbox(bytes, nonce, key)) };
};
const unlockFile = (all, keyB64) => {
  const out = nacl.secretbox.open(all.slice(nacl.secretbox.nonceLength), all.slice(0, nacl.secretbox.nonceLength), decodeBase64(keyB64));
  if (!out) throw new Error('This file can’t be unlocked.');
  return out;
};
async function fetchBytes(path, bucket = 'chat-images') {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
  if (error) throw error;
  return new Uint8Array(await (await fetch(data.signedUrl)).arrayBuffer());
}
// Statuses: text and photos are locked for every allowed viewer. Videos are not encrypted yet.
async function lockStatus(payload, audience, audIds, meId) {
  const [kp, { data: contacts, error }] = await Promise.all([myKeys(), supabase.rpc('my_contacts')]);
  if (error) throw error;
  const all = (contacts || []).map((c) => c.user_id);
  const ids = audience === 'all' ? all : audience === 'except' ? all.filter((id) => !audIds.includes(id)) : audIds;
  const want = [...new Set([...ids, meId])];
  const { data: pubs } = await supabase.from('profiles').select('id, public_key').in('id', want);
  const byId = {};
  (pubs || []).forEach((x) => { if (x.public_key) byId[x.id] = decodeBase64(x.public_key); });
  if (!byId[meId]) throw new Error('Your encryption key isn’t ready. Close and reopen the app, then try again.');
  const locked = lockForMembers(JSON.stringify(payload), byId, kp.secretKey);
  return { ...locked, missing: want.filter((id) => !byId[id]).length };
}
async function decryptStatuses(rows, meId) {
  const enc = rows.filter((r) => r.enc);
  if (!enc.length) return rows;
  const ids = [...new Set(enc.map((r) => r.user_id))];
  const [kp, { data: pubs }] = await Promise.all([myKeys(), supabase.from('profiles').select('id, public_key').in('id', ids)]);
  const byId = {};
  (pubs || []).forEach((x) => { if (x.public_key) byId[x.id] = decodeBase64(x.public_key); });
  return rows.map((r) => {
    if (!r.enc) return r;
    let p = null;
    try { p = JSON.parse(unlockFromSender(r.enc, r.enc_keys?.[meId], byId[r.user_id], kp.secretKey)); } catch (e) { p = null; }
    return p ? { ...r, body: p.b ?? null, fileKey: p.k ?? null } : { ...r, body: '🔒 Can’t unlock', locked: true };
  });
}
// ---- Encrypted key backup ----
const deriveKey = (pass, salt) => scrypt(decodeUTF8(pass.normalize('NFKC')), salt, 16384, 8, 1, 32);
async function makeBackup(pass) {
  const sk = await SecureStore.getItemAsync('chatup.nacl.secret');
  if (!sk) throw new Error('No key on this phone to back up.');
  const salt = nacl.randomBytes(16), nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const dk = await deriveKey(pass, salt);
  const blob = encodeBase64(cat(cat(salt, nonce), nacl.secretbox(decodeBase64(sk), nonce, dk)));
  const { error } = await supabase.from('key_backups').upsert({ blob, updated_at: new Date().toISOString() });
  if (error) throw error;
}
async function restoreBackup(blob, pass) {
  const all = decodeBase64(blob);
  const dk = await deriveKey(pass, all.slice(0, 16));
  const sk = nacl.secretbox.open(all.slice(16 + nacl.secretbox.nonceLength), all.slice(16, 16 + nacl.secretbox.nonceLength), dk);
  if (!sk) return false;
  await SecureStore.setItemAsync('chatup.nacl.secret', encodeBase64(sk));
  return true;
}
const CANT_READ = '🔒 This message can’t be unlocked on this phone';
// Both phones show the same number. If the two people read it out and it matches, nobody is in the middle.
const safetyNumber = (pubA, pubB) => {
  const [x, y] = [encodeBase64(pubA), encodeBase64(pubB)].sort();
  const h = nacl.hash(cat(decodeBase64(x), decodeBase64(y)));
  const groups = [];
  for (let i = 0; i < 10; i += 2) groups.push(String(((h[i] << 8) | h[i + 1]) % 100000).padStart(5, '0'));
  return groups.join(' ');
};

// The call screen uses this: pass the other person's profile.allow_recording.
// Their video stays unrecordable on THIS phone until they have allowed recording.
export function CallRecordingGuard({ remoteAllowsRecording }) {
  useScreenProtection(!remoteAllowsRecording, 'call');
  return null;
}

const LIGHT = { bg: '#f4f5fb', surf: '#ffffff', ink: '#16182b', mute: '#6b6f88', line: '#e4e6f2', acc: '#5448ee', accInk: '#ffffff', inn: '#ffffff', out: '#5448ee', outInk: '#ffffff' };
const DARK = { bg: '#0f1020', surf: '#181a31', ink: '#eceefb', mute: '#9a9fc2', line: '#272a4a', acc: '#8b84ff', accInk: '#0f1020', inn: '#22244a', out: '#5448ee', outInk: '#ffffff' };
const AV = ['#5448ee', '#e0527a', '#17a398', '#e08a1e', '#3b82c4', '#8a5cf6', '#c0563b'];

function useStyles() {
  const t = useColorScheme() === 'dark' ? DARK : LIGHT;
  const s = useMemo(() => StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.surf },
    center: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: t.surf },
    h1: { fontSize: 34, fontWeight: '700', color: t.acc, marginBottom: 8 },
    h2: { fontSize: 20, fontWeight: '700', color: t.ink },
    mute: { color: t.mute, fontSize: 15 },
    link: { color: t.acc, fontWeight: '600' },
    input: { borderWidth: 1, borderColor: t.line, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12, marginVertical: 12, fontSize: 16, backgroundColor: t.bg, color: t.ink },
    btn: { backgroundColor: t.acc, borderRadius: 14, padding: 14, alignItems: 'center', marginTop: 6 },
    btnQuiet: { backgroundColor: 'transparent' },
    btnText: { color: t.accInk, fontWeight: '700' },
    bar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderColor: t.line, backgroundColor: t.surf },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: t.surf },
    go: { backgroundColor: t.acc, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 13 },
    chatRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
    name: { fontSize: 17, fontWeight: '700', color: t.ink },
    list: { flex: 1, backgroundColor: t.surf },
    msgs: { flex: 1, backgroundColor: t.bg },
    msg: { maxWidth: '80%', padding: 10, borderRadius: 18 },
    out: { alignSelf: 'flex-end', backgroundColor: t.out, borderBottomRightRadius: 6 },
    inn: { alignSelf: 'flex-start', backgroundColor: t.inn, borderBottomLeftRadius: 6 },
  }), [t]);
  return { t, s };
}

const dayLabel = (d) => {
  const x = new Date(d), n = new Date(), y = new Date(n);
  y.setDate(n.getDate() - 1);
  return x.toDateString() === n.toDateString() ? 'Today' : x.toDateString() === y.toDateString() ? 'Yesterday' : x.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};
const listTime = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return x.toDateString() === new Date().toDateString() ? x.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : x.toLocaleDateString([], { day: 'numeric', month: 'short' });
};
const label = (c) => c?.other_name || (c?.other_phone ? '+' + c.other_phone : c?.is_group ? 'Group' : 'Deleted account');
const snippet = (m) => (m ? (m.deleted_at ? 'Message deleted' : m.body || (m.image_path ? '📷 Photo' : m.audio_path ? '🎤 Voice note' : '')) : 'Message');
const initials = (n) => (n || '?').replace('+', '').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const hue = (n) => AV[[...(n || '')].reduce((a, c) => a + c.charCodeAt(0), 0) % AV.length];

function Avatar({ name, size = 48, round }) {
  return (
    <View style={{ width: size, height: size, borderRadius: round ? size / 2 : size / 3, backgroundColor: hue(name), alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size / 2.8 }}>{initials(name)}</Text>
    </View>
  );
}

function Btn({ label: text, onPress, quiet }) {
  const { t, s } = useStyles();
  return (
    <Pressable onPress={onPress} style={[s.btn, quiet && s.btnQuiet]} accessibilityRole="button">
      <Text style={[s.btnText, quiet && { color: t.acc }]}>{text}</Text>
    </Pressable>
  );
}

// Replace these with your real public pages and support email before you build for the stores.
const TERMS_URL = 'https://mrsegunsimon-cloud.github.io/chat-up-mobile/terms.html';
const PRIVACY_URL = 'https://mrsegunsimon-cloud.github.io/chat-up-mobile/privacy.html';
const SUPPORT_EMAIL = 'mrsegunsimon@gmail.com';
const openUrl = (u) => Linking.openURL(u).catch(() => Alert.alert('Can’t open the link', u));
function LegalLine() {
  const { s } = useStyles();
  return (
    <Text style={[s.mute, { textAlign: 'center', marginTop: 16, fontSize: 12 }]}>
      By continuing you agree to the <Text style={s.link} onPress={() => openUrl(TERMS_URL)}>Terms of Use</Text> and <Text style={s.link} onPress={() => openUrl(PRIVACY_URL)}>Privacy Policy</Text>.
    </Text>
  );
}

function Login() {
  const { s } = useStyles();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const send = async () => {
    const { error } = await supabase.auth.signInWithOtp({ phone: phone.trim() });
    error ? fail(error) : setSent(true);
  };
  const verify = async () => {
    const { error } = await supabase.auth.verifyOtp({ phone: phone.trim(), token: code.trim(), type: 'sms' });
    if (error) fail(error);
  };
  return (
    <SafeAreaView style={s.center}>
      <Text style={s.h1}>Chat Up</Text>
      <Text style={s.mute}>{sent ? 'Enter the 6-digit code we texted you.' : 'Enter your phone number with country code, like +14155550123.'}</Text>
      {!sent ? (
        <>
          <TextInput style={s.input} value={phone} onChangeText={setPhone} placeholder="+14155550123" keyboardType="phone-pad" autoFocus />
          <Btn label="Send code" onPress={send} />
          <LegalLine />
        </>
      ) : (
        <>
          <TextInput style={s.input} value={code} onChangeText={setCode} placeholder="123456" keyboardType="number-pad" autoFocus />
          <Btn label="Verify and sign in" onPress={verify} />
          <Btn label="Use a different number" onPress={() => setSent(false)} quiet />
        </>
      )}
    </SafeAreaView>
  );
}

const confirmDeleteAccount = () => Alert.alert(
  'Delete your account?',
  'This permanently deletes your profile, statuses and login. Messages you sent stay in other people’s chats and show as a deleted account. This cannot be undone.',
  [{ text: 'Cancel', style: 'cancel' }, { text: 'Delete', style: 'destructive', onPress: async () => {
    const l = await supabase.rpc('leave_all_groups');
    if (l.error) return fail(l.error);
    const { error } = await supabase.functions.invoke('delete-account');
    if (error) return fail(error);
    await supabase.auth.signOut();
  } }],
);

function HeaderMenu({ items }) {
  const { t, s } = useStyles();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="More options" hitSlop={8}><Text style={{ fontSize: 26, color: t.ink, paddingHorizontal: 6 }}>⋮</Text></Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={{ flex: 1 }} onPress={() => setOpen(false)} accessibilityLabel="Close menu">
          <View style={{ position: 'absolute', top: 56, right: 12, minWidth: 220, backgroundColor: t.surf, borderRadius: 16, borderWidth: 1, borderColor: t.line, paddingVertical: 6, elevation: 8, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 12 }}>
            {items.map(([text, fn]) => (
              <Pressable key={text} onPress={() => { setOpen(false); fn(); }} accessibilityRole="menuitem" style={{ paddingHorizontal: 18, paddingVertical: 13 }}><Text style={{ fontSize: 16, color: t.ink }}>{text}</Text></Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const REPORT_REASONS = [['spam', 'Spam or scam'], ['harassment', 'Harassment or abuse'], ['illegal', 'Illegal or dangerous content'], ['impersonation', 'Pretending to be someone else'], ['other', 'Something else']];
// Reports go to you (the app owner) in the Supabase "reports" table. `target` = { reportedId, messageId?, statusId?, excerpt? }.
function ReportSheet({ target, onClose }) {
  const { s, t } = useStyles();
  const [sendText, setSendText] = useState(false);
  const [busy, setBusy] = useState(false);
  const send = async (reason) => {
    if (busy) return;
    setBusy(true);
    const { error } = await supabase.from('reports').insert({
      reported_id: target.reportedId || null, message_id: target.messageId || null, status_id: target.statusId || null,
      reason, excerpt: sendText && target.excerpt ? String(target.excerpt).slice(0, 2000) : null,
    });
    setBusy(false);
    if (error) return fail(error);
    onClose();
    Alert.alert('Report sent', 'Thank you. We will look at it. You can also block this person so they cannot contact you.');
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(10,10,30,0.45)', justifyContent: 'flex-end' }} onPress={onClose}>
        <View style={{ backgroundColor: t.surf, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16, paddingBottom: 28 }}>
          <Text style={[s.h2, { marginBottom: 4 }]}>Report</Text>
          <Text style={[s.mute, { marginBottom: 8 }]}>Chats are private, so we only see what you choose to send.</Text>
          {target.excerpt ? (
            <Pressable onPress={() => setSendText(!sendText)} accessibilityRole="checkbox" accessibilityState={{ checked: sendText }} style={{ flexDirection: 'row', gap: 10, alignItems: 'center', paddingVertical: 8 }}>
              <Text style={{ fontSize: 20 }}>{sendText ? '☑' : '☐'}</Text>
              <Text style={{ flex: 1, color: t.ink }}>Include this message text in the report</Text>
            </Pressable>
          ) : null}
          {REPORT_REASONS.map(([k, label]) => (
            <Pressable key={k} onPress={() => send(k)} accessibilityRole="button" style={{ paddingVertical: 14 }}><Text style={{ fontSize: 17, color: t.ink }}>{label}</Text></Pressable>
          ))}
          <Pressable onPress={onClose} accessibilityRole="button" style={{ paddingVertical: 14 }}><Text style={{ fontSize: 17, color: t.mute }}>Cancel</Text></Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

function BlockedList({ onClose }) {
  const { s } = useStyles();
  const [rows, setRows] = useState(null);
  const load = async () => {
    const { data, error } = await supabase.from('blocks').select('blocked, profiles!blocked(name, phone)');
    if (error) { fail(error); setRows([]); } else setRows(data || []);
  };
  useEffect(() => { load(); }, []);
  const unblock = async (id) => {
    const { error } = await supabase.from('blocks').delete().eq('blocked', id);
    error ? fail(error) : load();
  };
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.screen}>
        <View style={s.bar}><Pressable onPress={onClose}><Text style={s.link}>Close</Text></Pressable><Text style={s.h2}>Blocked people</Text><View style={{ width: 50 }} /></View>
        <ScrollView style={s.list}>
          {rows && !rows.length ? <Text style={[s.mute, { padding: 24, textAlign: 'center' }]}>You haven’t blocked anyone.</Text> : null}
          {(rows || []).map((r) => (
            <View key={r.blocked} style={s.chatRow}>
              <Text style={[s.name, { flex: 1 }]}>{r.profiles?.name || (r.profiles?.phone ? '+' + r.profiles.phone : 'Unknown')}</Text>
              <Pressable onPress={() => unblock(r.blocked)}><Text style={s.link}>Unblock</Text></Pressable>
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Profile({ profile, onSaved, onCancel, protect, setProtect }) {
  const { s } = useStyles();
  const [showBlocked, setShowBlocked] = useState(false);
  const deleteAccount = confirmDeleteAccount;
  const [name, setName] = useState(profile.name || '');
  const [allowRec, setAllowRec] = useState(!!profile.allow_recording);
  const save = async () => {
    const n = name.trim();
    if (!n) return Alert.alert('Add a name', 'Friends will see this name in their chat list.');
    const { error } = await supabase.from('profiles').update({ name: n, allow_recording: allowRec }).eq('id', profile.id);
    error ? fail(error) : onSaved({ ...profile, name: n, allow_recording: allowRec });
  };
  return (
    <SafeAreaView style={s.screen}>
      <ScrollView contentContainerStyle={{ padding: 24 }}>
      <Text style={s.h1}>{profile.name ? 'Your profile' : 'What’s your name?'}</Text>
      <Text style={s.mute}>Friends see this name instead of your phone number.</Text>
      <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Your name" autoFocus maxLength={40} />
      <View style={s.row}>
        <View style={{ flex: 1 }}><Text style={s.name}>Allow recording of me on calls</Text><Text style={s.mute}>Off by default. When off, people on a call with you can’t screen record your video.</Text></View>
        <Switch value={allowRec} onValueChange={setAllowRec} accessibilityLabel="Allow recording of me on calls" />
      </View>
      <View style={s.row}>
        <View style={{ flex: 1 }}><Text style={s.name}>Protect my chats</Text><Text style={s.mute}>Blocks screen recording of Chat Up on this phone.</Text></View>
        <Switch value={protect} onValueChange={setProtect} accessibilityLabel="Protect my chats from screen recording" />
      </View>
      <Btn label="Save" onPress={save} />
      {profile.name ? <Btn label="Cancel" onPress={onCancel} quiet /> : null}
      {profile.name ? <Btn label="Blocked people" onPress={() => setShowBlocked(true)} quiet /> : null}
      <Btn label="Sign out" onPress={() => supabase.auth.signOut()} quiet />
      {profile.name ? <Pressable onPress={deleteAccount} accessibilityRole="button" style={{ alignItems: 'center', padding: 14 }}><Text style={{ color: '#e5484d', fontWeight: '700' }}>Delete my account</Text></Pressable> : null}
      </ScrollView>
      {showBlocked && <BlockedList onClose={() => setShowBlocked(false)} />}
    </SafeAreaView>
  );
}

function NewGroup({ onClose, onCreated }) {
  const { t, s } = useStyles();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [phones, setPhones] = useState([]);
  const [busy, setBusy] = useState(false);
  const add = () => {
    const d = phone.replace(/\D/g, '');
    if (d.length < 7) return Alert.alert('Check the number', 'Enter the full number with country code, like +14155550123.');
    if (!phones.includes(d)) setPhones([...phones, d]);
    setPhone('');
  };
  const create = async () => {
    if (!name.trim()) return Alert.alert('Add a name', 'Give the group a name.');
    if (phones.length < 2) return Alert.alert('Add more people', 'A group needs at least 2 other people.');
    setBusy(true);
    const { data, error } = await supabase.rpc('create_group', { group_name: name.trim(), member_phones: phones });
    setBusy(false);
    if (error) return fail(error);
    onCreated({ conversation_id: data, is_group: true, other_name: name.trim() });
  };
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.screen}>
        <View style={s.bar}>
          <Pressable onPress={onClose}><Text style={s.link}>Cancel</Text></Pressable>
          <Text style={s.h2}>New group</Text>
          <View style={{ width: 50 }} />
        </View>
        <View style={{ padding: 16 }}>
          <TextInput style={s.input} value={name} onChangeText={setName} placeholder="Group name" maxLength={40} />
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <TextInput style={[s.input, { flex: 1, marginVertical: 0 }]} value={phone} onChangeText={setPhone} placeholder="Add a number: +14155550123" keyboardType="phone-pad" onSubmitEditing={add} />
            <Pressable onPress={add} style={s.go} accessibilityLabel="Add person"><Text style={s.btnText}>Add</Text></Pressable>
          </View>
          <Text style={[s.mute, { marginTop: 8 }]}>Everyone must have signed in to Chat Up. People added: {phones.length} (you make it {phones.length + 1}, up to 50).</Text>
        </View>
        <FlatList
          style={s.list}
          data={phones}
          keyExtractor={(p) => p}
          renderItem={({ item }) => (
            <View style={s.chatRow}>
              <Avatar name={item} size={40} round />
              <Text style={[s.name, { flex: 1 }]}>+{item}</Text>
              <Pressable onPress={() => setPhones(phones.filter((x) => x !== item))} accessibilityLabel={`Remove ${item}`}><Text style={s.link}>Remove</Text></Pressable>
            </View>
          )}
        />
        <View style={{ padding: 16 }}><Btn label={busy ? 'Creating…' : 'Create group'} onPress={busy ? () => {} : create} /></View>
      </SafeAreaView>
    </Modal>
  );
}

function Chats({ profile, onOpen, onProfile, onUpdates }) {
  const { t, s } = useStyles();
  const [stories, setStories] = useState([]);
  const [seen, setSeen] = useState([]);
  const [story, setStory] = useState(null);
  const [composing, setComposing] = useState(false);
  const [flt, setFlt] = useState('all');
  const [groupOpen, setGroupOpen] = useState(false);
  const [chats, setChats] = useState([]);
  const [phone, setPhone] = useState('');
  const [q, setQ] = useState('');
  // Archive, lock and hide apply on this phone only.
  const [flags, setFlags] = useState({ archived: [], locked: [], hidden: [], code: '' });
  const [menu, setMenu] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [codeFor, setCodeFor] = useState(null);
  const [codeText, setCodeText] = useState('');
  const saveFlags = (f) => { setFlags(f); AsyncStorage.setItem('chatup.chatflags', JSON.stringify(f)); };
  const toggle = (key, id) => {
    const on = flags[key].includes(id);
    saveFlags({ ...flags, [key]: on ? flags[key].filter((x) => x !== id) : [...flags[key], id] });
  };
  const lockChat = async (id) => {
    if (flags.locked.includes(id)) return toggle('locked', id);
    const has = await LocalAuthentication.hasHardwareAsync();
    const enrolled = has && (await LocalAuthentication.isEnrolledAsync());
    if (!enrolled) return Alert.alert('Set up a screen lock first', 'To lock chats, turn on a fingerprint, face unlock or passcode in your phone’s settings.');
    toggle('locked', id);
  };
  const hideChat = (id) => {
    if (flags.hidden.includes(id)) return toggle('hidden', id);
    if (!flags.code) { setCodeText(''); return setCodeFor(id); }
    toggle('hidden', id);
    Alert.alert('Chat hidden', 'Type your secret code in the search bar to see hidden chats.');
  };
  const open = async (c) => {
    if (flags.locked.includes(c.conversation_id)) {
      const r = await LocalAuthentication.authenticateAsync({ promptMessage: 'Unlock this chat', fallbackLabel: 'Use passcode' });
      if (!r.success) return;
    }
    onOpen(c);
  };
  const load = async () => {
    const { data, error } = await supabase.rpc('my_chats');
    if (error) return fail(error);
    const ids = [...new Set(data.filter((c) => c.last_enc && !c.last_body).map((c) => (c.is_group ? c.last_sender : c.other_id)).filter(Boolean))];
    if (!ids.length) return setChats(data);
    const [kp, { data: pubs }] = await Promise.all([myKeys(), supabase.from('profiles').select('id, public_key').in('id', ids)]);
    const byId = {};
    (pubs || []).forEach((x) => { if (x.public_key) byId[x.id] = decodeBase64(x.public_key); });
    const meId = (await supabase.auth.getUser()).data.user?.id;
    setChats(data.map((c) => {
      if (!c.last_enc || c.last_body) return c;
      const txt = c.is_group
        ? unlockFromSender(c.last_enc, c.last_keys?.[meId], byId[c.last_sender], kp.secretKey)
        : (byId[c.other_id] && decText(c.last_enc, byId[c.other_id], kp.secretKey));
      return { ...c, last_body: txt || CANT_READ };
    }));
  };
  const readAll = async () => {
    const ids = chats.filter((c) => c.unread > 0).map((c) => c.conversation_id);
    if (!ids.length) return Alert.alert('All caught up', 'You have no unread chats.');
    const r = await Promise.all(ids.map((cid) => supabase.rpc('mark_read', { cid })));
    const bad = r.find((x) => x.error);
    bad ? fail(bad.error) : load();
  };
  const loadStories = async () => {
    const { data } = await supabase.from('statuses').select('*, profiles(name, phone)').gt('expires_at', new Date().toISOString()).order('created_at');
    setStories(await decryptStatuses(data || [], profile.id));
  };
  const markSeen = (id) => setSeen((p) => {
    if (p.includes(id)) return p;
    const n = [...p, id].slice(-500);
    AsyncStorage.setItem('chatup.seen', JSON.stringify(n));
    return n;
  });
  const circles = useMemo(() => {
    const by = {};
    stories.forEach((st) => { if (!by[st.user_id]) by[st.user_id] = []; by[st.user_id].push(st); });
    const asc = (a, b) => new Date(a.created_at) - new Date(b.created_at);
    const others = Object.keys(by).filter((id) => id !== profile.id).map((id) => {
      const items = by[id].sort(asc);
      return { user_id: id, name: items[0].profiles?.name || '+' + items[0].profiles?.phone, items, unseen: items.some((i) => !seen.includes(i.id)) };
    }).sort((a, b) => Number(b.unseen) - Number(a.unseen));
    return [{ user_id: profile.id, name: profile.name || 'Me', mine: true, items: (by[profile.id] || []).sort(asc), unseen: false }, ...others];
  }, [stories, seen]);
  useEffect(() => {
    load();
    loadStories();
    AsyncStorage.getItem('chatup.seen').then((v) => { if (v) setSeen(JSON.parse(v)); });
    AsyncStorage.getItem('chatup.chatflags').then((v) => { if (v) setFlags(JSON.parse(v)); });
    const ch = supabase.channel('chat-list').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, load).subscribe();
    return () => supabase.removeChannel(ch);
  }, []);
  const start = async () => {
    const { data, error } = await supabase.rpc('start_chat', { other_phone: phone });
    if (error) return fail(error);
    setPhone('');
    await load();
    onOpen({ conversation_id: data, other_phone: phone.replace(/\D/g, '') });
  };
  const codeMode = !!flags.code && q.trim() === flags.code;
  const hiddenIds = flags.hidden, archIds = flags.archived;
  const archivedCount = chats.filter((c) => archIds.includes(c.conversation_id) && !hiddenIds.includes(c.conversation_id)).length;
  const shown = codeMode
    ? chats.filter((c) => hiddenIds.includes(c.conversation_id))
    : showArchived
      ? chats.filter((c) => archIds.includes(c.conversation_id) && !hiddenIds.includes(c.conversation_id))
      : chats.filter((c) => !archIds.includes(c.conversation_id) && !hiddenIds.includes(c.conversation_id))
        .filter((c) => !q.trim() || (label(c) + ' ' + (c.last_body || '')).toLowerCase().includes(q.trim().toLowerCase())).filter((c) => flt === 'all' || c.unread > 0);
  return (
    <SafeAreaView style={s.screen}>
      <View style={s.bar}>
        <Text style={[s.h2, { color: t.acc, fontSize: 24 }]}>Chat Up</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Pressable onPress={() => setComposing(true)} accessibilityRole="button" accessibilityLabel="New photo or video status" hitSlop={8}><Text style={{ fontSize: 22 }}>📷</Text></Pressable>
          <HeaderMenu items={[['New group', () => setGroupOpen(true)], ['Read all', readAll], ['Settings', onProfile]]} />
        </View>
      </View>
      <View style={s.row}>
        <TextInput style={[s.input, { flex: 1, marginVertical: 0, borderWidth: 0, borderRadius: 26, paddingHorizontal: 18 }]} value={q} onChangeText={setQ} placeholder="Search chats" accessibilityLabel="Search chats" />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, backgroundColor: t.surf, borderBottomWidth: 1, borderColor: t.line }} contentContainerStyle={{ padding: 12, gap: 14 }}>
        {circles.map((c) => (
          <View key={c.user_id} style={{ alignItems: 'center', width: 66 }}>
            <Pressable onPress={() => (c.items.length ? setStory(c.items) : c.mine && setComposing(true))} accessibilityLabel={`${c.mine ? 'My' : c.name} status`}>
              <View style={{ padding: 3, borderRadius: 40, borderWidth: 3, borderColor: !c.items.length ? 'transparent' : c.mine || c.unseen ? t.acc : t.line }}>
                <Avatar name={c.name} size={52} round />
              </View>
            </Pressable>
            {c.mine && (
              <Pressable onPress={() => setComposing(true)} accessibilityLabel="Add a status" style={{ position: 'absolute', top: 40, right: 2, width: 22, height: 22, borderRadius: 11, backgroundColor: t.acc, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: t.surf }}>
                <Text style={{ color: t.accInk, fontSize: 14, fontWeight: '700', lineHeight: 16 }}>+</Text>
              </Pressable>
            )}
            <Text style={[s.mute, { fontSize: 12, marginTop: 4 }]} numberOfLines={1}>{c.mine ? 'My status' : c.name.split(' ')[0]}</Text>
          </View>
        ))}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: t.surf }}>
        {[['all', 'All'], ['unread', 'Unread']].map(([k, l]) => (
          <Pressable key={k} onPress={() => setFlt(k)} accessibilityRole="button" accessibilityState={{ selected: flt === k }} style={{ paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16, backgroundColor: flt === k ? t.acc : t.bg }}>
            <Text style={{ color: flt === k ? t.accInk : t.mute, fontWeight: flt === k ? '700' : '400' }}>{l}</Text>
          </Pressable>
        ))}
      </View>
      <FlatList
        style={s.list}
        data={shown}
        keyExtractor={(c) => c.conversation_id}
        ListHeaderComponent={codeMode ? <Text style={[s.mute, { padding: 12, fontWeight: '700' }]}>Hidden chats</Text> : showArchived ? (
          <Pressable onPress={() => setShowArchived(false)} accessibilityRole="button" style={[s.chatRow, { paddingVertical: 12 }]}><Text style={{ fontSize: 22, color: t.ink }}>←</Text><Text style={s.h2}>Archived</Text></Pressable>
        ) : archivedCount && !q.trim() ? (
          <Pressable onPress={() => setShowArchived(true)} accessibilityRole="button" style={s.chatRow}>
            <View style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 22 }}>🗂</Text></View>
            <Text style={[s.name, { flex: 1 }]}>Archived</Text><Text style={s.mute}>{archivedCount}</Text>
          </Pressable>
        ) : null}
        ListEmptyComponent={<Text style={[s.mute, { textAlign: 'center', marginTop: 40, paddingHorizontal: 24 }]}>{q ? 'No matches. Try a different name or word.' : 'No chats yet. Enter a friend’s number below. They need to have signed in to Chat Up first.'}</Text>}
        renderItem={({ item }) => (
          <Pressable style={s.chatRow} onPress={() => open(item)} onLongPress={() => setMenu(item)} delayLongPress={400}>
            <Avatar name={label(item)} />
            <View style={{ flex: 1 }}>
              <Text style={s.name}>{label(item)}</Text>
              <Text style={s.mute} numberOfLines={1}>
                {item.last_from_me ? <Text style={{ color: item.other_last_read && new Date(item.other_last_read) >= new Date(item.last_at) ? t.acc : t.mute }}>{item.other_last_read && new Date(item.other_last_read) >= new Date(item.last_at) ? '✓✓ ' : '✓ '}</Text> : null}
                {flags.locked.includes(item.conversation_id) ? '🔒 Locked chat' : (item.last_body || 'No messages yet')}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ fontSize: 12, color: item.unread ? t.acc : t.mute, fontWeight: item.unread ? '700' : '400' }}>{listTime(item.last_at)}</Text>
              {item.unread && !flags.locked.includes(item.conversation_id) ? <View style={{ minWidth: 20, paddingHorizontal: 6, borderRadius: 10, backgroundColor: t.acc, marginTop: 4, alignItems: 'center' }}><Text style={{ color: t.accInk, fontWeight: '700', fontSize: 12 }}>{item.unread}</Text></View> : null}
            </View>
          </Pressable>
        )}
      />
      <View style={[s.row, { borderTopWidth: 1, borderColor: 'transparent' }]}>
        <TextInput style={[s.input, { flex: 1, marginVertical: 0 }]} value={phone} onChangeText={setPhone} placeholder="New chat: +14155550123" keyboardType="phone-pad" />
        <Pressable onPress={start} style={s.go}><Text style={s.btnText}>Start</Text></Pressable>
      </View>
      <Modal visible={!!menu} transparent animationType="fade" onRequestClose={() => setMenu(null)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(10,10,30,0.45)', justifyContent: 'flex-end' }} onPress={() => setMenu(null)}>
          <View style={{ backgroundColor: t.surf, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 16, paddingBottom: 28 }}>
            <Text style={[s.h2, { marginBottom: 8 }]}>{menu ? label(menu) : ''}</Text>
            {menu ? [
              [flags.archived.includes(menu.conversation_id) ? 'Unarchive chat' : 'Archive chat', () => toggle('archived', menu.conversation_id)],
              [flags.locked.includes(menu.conversation_id) ? 'Unlock chat' : 'Lock chat', () => lockChat(menu.conversation_id)],
              [flags.hidden.includes(menu.conversation_id) ? 'Unhide chat' : 'Hide chat', () => hideChat(menu.conversation_id)],
            ].map(([text, fn]) => (
              <Pressable key={text} onPress={() => { setMenu(null); fn(); }} accessibilityRole="button" style={{ paddingVertical: 14 }}><Text style={{ fontSize: 17, color: t.ink }}>{text}</Text></Pressable>
            )) : null}
            <Text style={[s.mute, { marginTop: 6 }]}>Archive, lock and hide apply on this phone only.</Text>
          </View>
        </Pressable>
      </Modal>
      <Modal visible={!!codeFor} transparent animationType="fade" onRequestClose={() => setCodeFor(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(10,10,30,0.45)', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: t.surf, borderRadius: 20, padding: 20 }}>
            <Text style={s.h2}>Choose a secret code</Text>
            <Text style={[s.mute, { marginTop: 6 }]}>Type this code in the search bar to show hidden chats. At least 4 characters. It can’t be recovered if you forget it.</Text>
            <TextInput style={s.input} value={codeText} onChangeText={setCodeText} placeholder="Secret code" maxLength={20} autoCapitalize="none" secureTextEntry accessibilityLabel="Secret code" />
            <Btn label="Save and hide" onPress={() => {
              const v = codeText.trim();
              if (v.length < 4) return Alert.alert('Too short', 'Use at least 4 characters.');
              saveFlags({ ...flags, code: v, hidden: [...flags.hidden, codeFor] }); setCodeFor(null);
              Alert.alert('Chat hidden', 'Type your secret code in the search bar to see hidden chats.');
            }} />
            <Btn label="Cancel" onPress={() => setCodeFor(null)} quiet />
          </View>
        </View>
      </Modal>
      {groupOpen && <NewGroup onClose={() => setGroupOpen(false)} onCreated={async (c) => { setGroupOpen(false); await load(); onOpen(c); }} />}
      {composing && <StatusFlow me={profile.id} onClose={() => setComposing(false)} onPosted={loadStories} />}
      {story && (
        <StatusViewer items={story} me={profile.id} onSeen={markSeen} onClose={() => { setStory(null); loadStories(); }}
          onDelete={async (it) => {
            if (it.media_path) await supabase.storage.from('status-media').remove([it.media_path]);
            const { error } = await supabase.from('statuses').delete().eq('id', it.id);
            if (error) fail(error);
            setStory(null); loadStories();
          }} />
      )}
    </SafeAreaView>
  );
}

function Photo({ path, fileKey, locked }) {
  const { s } = useStyles();
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (locked) return;
    if (fileKey) {
      fetchBytes(path).then((all) => setUrl('data:image/jpeg;base64,' + encodeBase64(unlockFile(all, fileKey)))).catch(() => setFailed(true));
    } else {
      supabase.storage.from('chat-images').createSignedUrl(path, 3600).then(({ data }) => setUrl(data?.signedUrl));
    }
  }, [path, fileKey]);
  if (locked || failed) return <Text style={s.mute}>🔒 This photo can’t be unlocked on this phone</Text>;
  return url ? <Image source={{ uri: url }} style={{ width: 220, height: 220, borderRadius: 12 }} /> : <Text style={s.mute}>Loading photo…</Text>;
}

function VoiceNote({ path, mine, fileKey, locked }) {
  const { t } = useStyles();
  const [sound, setSound] = useState(null);
  const [playing, setPlaying] = useState(false);
  const tmp = useRef(null);
  const cleanTmp = () => { if (tmp.current) { FileSystem.deleteAsync(tmp.current, { idempotent: true }); tmp.current = null; } };
  useEffect(() => () => { sound?.unloadAsync(); }, [sound]);
  useEffect(() => cleanTmp, []);
  const toggle = async () => {
    try {
      if (locked) return Alert.alert('Can’t play', 'This voice note can’t be unlocked on this phone.');
      if (sound) {
        const st = await sound.getStatusAsync();
        if (st.isPlaying) { await sound.pauseAsync(); setPlaying(false); } else { if (st.didJustFinish || st.positionMillis >= (st.durationMillis || 1)) await sound.setPositionAsync(0); await sound.playAsync(); setPlaying(true); }
        return;
      }
      let uri;
      if (fileKey) {
        // Unlock on the phone and keep the plain file only while this note is on screen.
        const bytes = unlockFile(await fetchBytes(path), fileKey);
        tmp.current = FileSystem.cacheDirectory + 'vn-' + Date.now() + '.m4a';
        await FileSystem.writeAsStringAsync(tmp.current, encodeBase64(bytes), { encoding: FileSystem.EncodingType.Base64 });
        uri = tmp.current;
      } else {
        const { data, error } = await supabase.storage.from('chat-images').createSignedUrl(path, 3600);
        if (error) return fail(error);
        uri = data.signedUrl;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound: snd } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true }, (st) => { if (st.didJustFinish) setPlaying(false); });
      setSound(snd); setPlaying(true);
    } catch (e) { fail(e); }
  };
  return (
    <Pressable onPress={toggle} accessibilityLabel={playing ? 'Pause voice note' : 'Play voice note'} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 140 }}>
      <Text style={{ fontSize: 20, color: mine ? t.outInk : t.ink }}>{playing ? '⏸' : '▶'}</Text>
      <Text style={{ color: mine ? t.outInk : t.ink, fontSize: 16 }}>Voice note</Text>
    </Pressable>
  );
}

function ChatInfo({ chat, me, cid, isGroup, title, members, adminId, otherId, iBlocked, setIBlocked, onTitle, onClose, onChanged, onLeft }) {
  const { t, s } = useStyles();
  const isAdmin = isGroup && adminId === me;
  const [reporting, setReporting] = useState(null);
  const [name, setName] = useState(title);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (fn) => { setBusy(true); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); } };
  const rename = () => run(async () => {
    const { error } = await supabase.rpc('rename_group', { cid, new_name: name.trim() });
    if (error) throw error;
    onTitle(name.trim());
  });
  const addPerson = () => run(async () => {
    const d = phone.replace(/\D/g, '');
    if (d.length < 7) return Alert.alert('Check the number', 'Enter the full number with country code, like +14155550123.');
    const { error } = await supabase.rpc('add_group_members', { cid, member_phones: [d] });
    if (error) throw error;
    setPhone(''); onChanged();
  });
  const remove = (m) => Alert.alert(`Remove ${m.name}?`, 'They will stop getting new messages in this group.', [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => run(async () => { const { error } = await supabase.rpc('remove_group_member', { cid, member_id: m.id }); if (error) throw error; onChanged(); }) },
  ]);
  const leave = () => Alert.alert('Leave this group?', 'You will stop getting its messages.' + (isAdmin ? ' Another member becomes the admin.' : ''), [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Leave', style: 'destructive', onPress: () => run(async () => { const { error } = await supabase.rpc('leave_group', { cid }); if (error) throw error; onLeft(); }) },
  ]);
  const toggleBlock = () => {
    if (iBlocked) return run(async () => { const { error } = await supabase.from('blocks').delete().eq('blocker', me).eq('blocked', otherId); if (error) throw error; setIBlocked(false); });
    Alert.alert('Block this person?', 'They won’t be able to message you or see your statuses, and you won’t see theirs.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: () => run(async () => { const { error } = await supabase.from('blocks').insert({ blocked: otherId }); if (error) throw error; setIBlocked(true); }) },
    ]);
  };
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.screen}>
        <View style={s.bar}><Pressable onPress={onClose}><Text style={s.link}>Close</Text></Pressable><Text style={s.h2}>{isGroup ? 'Group info' : 'Contact info'}</Text><View style={{ width: 50 }} /></View>
        <ScrollView style={s.list} contentContainerStyle={{ padding: 16 }}>
          <View style={{ alignItems: 'center', marginBottom: 12 }}><Avatar name={title} size={80} round /></View>
          {isGroup ? (
            <>
              <TextInput style={s.input} value={name} onChangeText={setName} editable={isAdmin} maxLength={40} placeholder="Group name" />
              {isAdmin && name.trim() && name.trim() !== title ? <Btn label="Save group name" onPress={busy ? () => {} : rename} /> : null}
              <Text style={[s.mute, { fontWeight: '700', marginTop: 16 }]}>{members.length} people</Text>
              {members.map((m) => (
                <View key={m.id} style={[s.chatRow, { paddingHorizontal: 0 }]}>
                  <Avatar name={m.name} size={40} round />
                  <Text style={[s.name, { flex: 1 }]}>{m.id === me ? 'You' : m.name}{m.id === adminId ? '  · admin' : ''}</Text>
                  {isAdmin && m.id !== me ? <Pressable onPress={() => remove(m)}><Text style={{ color: '#e5484d' }}>Remove</Text></Pressable> : null}
                </View>
              ))}
              {isAdmin ? (
                <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 }}>
                  <TextInput style={[s.input, { flex: 1, marginVertical: 0 }]} value={phone} onChangeText={setPhone} placeholder="Add a number: +14155550123" keyboardType="phone-pad" onSubmitEditing={addPerson} />
                  <Pressable onPress={busy ? () => {} : addPerson} style={s.go} accessibilityLabel="Add person"><Text style={s.btnText}>Add</Text></Pressable>
                </View>
              ) : null}
              <Pressable onPress={busy ? () => {} : leave} style={{ alignItems: 'center', padding: 18 }}><Text style={{ color: '#e5484d', fontWeight: '700' }}>Leave group</Text></Pressable>
            </>
          ) : (
            <>
              <Text style={[s.h2, { textAlign: 'center' }]}>{title}</Text>
              {chat.other_phone ? <Text style={[s.mute, { textAlign: 'center' }]}>+{chat.other_phone}</Text> : null}
              {otherId ? <Pressable onPress={() => setReporting({ reportedId: otherId })} style={{ alignItems: 'center', padding: 10 }}><Text style={{ color: '#e5484d', fontWeight: '700' }}>Report this person</Text></Pressable> : null}
              {otherId ? <Pressable onPress={busy ? () => {} : toggleBlock} style={{ alignItems: 'center', padding: 18 }}><Text style={{ color: iBlocked ? t.acc : '#e5484d', fontWeight: '700' }}>{iBlocked ? 'Unblock this person' : 'Block this person'}</Text></Pressable> : null}
            </>
          )}
        </ScrollView>
        {reporting && <ReportSheet target={reporting} onClose={() => setReporting(null)} />}
      </SafeAreaView>
    </Modal>
  );
}

function Chat({ chat, me, onBack, onCall }) {
  const { t, s } = useStyles();
  const [rawMsgs, setMsgs] = useState([]);
  const [e2e, setE2e] = useState(null); // { secret, otherPub } for one-to-one chats
  const [text, setText] = useState('');
  const list = useRef();
  const rec = useRef(null);
  const [recording, setRecording] = useState(false);
  const cid = chat.conversation_id;
  const [otherRead, setOtherRead] = useState(null);
  const [typing, setTyping] = useState(false);
  const [names, setNames] = useState({});
  const [count, setCount] = useState(2);
  const reads = useRef({});
  const isGroup = !!chat.is_group;
  const chRef = useRef(null);
  const lastTyping = useRef(0);
  const [replyTo, setReplyTo] = useState(null);
  const [members, setMembers] = useState([]);
  const [adminId, setAdminId] = useState(null);
  const [otherId, setOtherId] = useState(null);
  const [iBlocked, setIBlocked] = useState(false);
  const [reportMsg, setReportMsg] = useState(null);
  const msgs = useMemo(() => rawMsgs.map((m) => {
    if (!m.enc) return m;
    const t = m.enc_keys ? unlockFromSender(m.enc, m.enc_keys[me], e2e?.pubs?.[m.sender_id], e2e?.secret) : (e2e?.otherPub ? decText(m.enc, e2e.otherPub, e2e.secret) : null);
    if (m.image_path || m.audio_path) { // the unlocked text holds this file's key
      let k = null;
      try { k = JSON.parse(t).k; } catch (e) { k = null; }
      return { ...m, body: null, fileKey: k };
    }
    return { ...m, body: t || CANT_READ };
  }), [rawMsgs, e2e]);
  useEffect(() => {
    if (!isGroup || !members.length) return;
    (async () => {
      const kp = await myKeys();
      const { data } = await supabase.from('profiles').select('id, public_key').in('id', members.map((x) => x.id));
      const pubs = {};
      (data || []).forEach((x) => { if (x.public_key) pubs[x.id] = decodeBase64(x.public_key); });
      setE2e({ secret: kp.secretKey, pubs });
    })();
  }, [isGroup, members]);
  useEffect(() => {
    if (isGroup || !otherId) return;
    (async () => {
      const kp = await myKeys();
      const { data } = await supabase.from('profiles').select('public_key').eq('id', otherId).single();
      setE2e({ secret: kp.secretKey, otherPub: data?.public_key ? decodeBase64(data.public_key) : null });
    })();
  }, [otherId]);
  const [infoOpen, setInfoOpen] = useState(false);
  const [title, setTitle] = useState(label(chat));
  const recompute = () => { const v = Object.values(reads.current); setOtherRead(v.length ? v.reduce((a, b) => (new Date(a) < new Date(b) ? a : b)) : null); }; // read by everyone = earliest time
  const loadMembers = () => {
    supabase.from('conversation_members').select('user_id, last_read_at, profiles(name, phone)').eq('conversation_id', cid).then(({ data }) => {
      const nm = {}; const list = []; reads.current = {};
      (data || []).forEach((r) => {
        const n = r.profiles?.name || (r.profiles?.phone ? '+' + r.profiles.phone : 'Someone');
        nm[r.user_id] = n; list.push({ id: r.user_id, name: n });
        if (r.user_id !== me) reads.current[r.user_id] = r.last_read_at;
      });
      setNames((p) => ({ ...p, ...nm })); setMembers(list); setCount(list.length); recompute();
      if (!isGroup) {
        const o = list.find((m) => m.id !== me);
        if (o) { setOtherId(o.id); supabase.from('blocks').select('blocked').eq('blocker', me).eq('blocked', o.id).then(({ data: b }) => setIBlocked(!!b?.length)); }
      }
    });
    if (isGroup) supabase.from('conversations').select('created_by').eq('id', cid).single().then(({ data }) => setAdminId(data?.created_by || null));
  };
  useEffect(() => {
    const markRead = () => supabase.rpc('mark_read', { cid });
    supabase.from('messages').select('*').eq('conversation_id', cid).order('created_at').then(({ data, error }) => { if (error) fail(error); else { setMsgs(data); markRead(); } });
    loadMembers();
    let typingTimer;
    const ch = supabase.channel('chat-' + cid, { config: { broadcast: { self: false } } })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${cid}` }, (p) => {
        setMsgs((m) => (m.some((x) => x.id === p.new.id) ? m : [...m, p.new]));
        if (p.new.sender_id !== me) { markRead(); setTyping(false); }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${cid}` }, (p) => {
        setMsgs((m) => m.map((x) => (x.id === p.new.id ? p.new : x))); // delete for everyone arrives as an update
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_members', filter: `conversation_id=eq.${cid}` }, (p) => {
        if (p.new.user_id !== me) { reads.current[p.new.user_id] = p.new.last_read_at; recompute(); }
      })
      .on('broadcast', { event: 'typing' }, () => { setTyping(true); clearTimeout(typingTimer); typingTimer = setTimeout(() => setTyping(false), 3000); })
      .subscribe();
    chRef.current = ch;
    return () => { clearTimeout(typingTimer); supabase.removeChannel(ch); };
  }, [cid]);
  const onType = (v) => {
    setText(v);
    if (v && Date.now() - lastTyping.current > 2000) { lastTyping.current = Date.now(); chRef.current?.send({ type: 'broadcast', event: 'typing', payload: {} }); }
  };
  const rows = useMemo(() => {
    const out = []; let last = '';
    msgs.forEach((m) => { const d = dayLabel(m.created_at); if (d !== last) { out.push({ sep: d, id: 'sep-' + m.id }); last = d; } out.push(m); });
    return out;
  }, [msgs]);
  const insertMsg = async (fields) => {
    const { error } = await supabase.from('messages').insert({ conversation_id: cid, reply_to: replyTo?.id || null, ...fields });
    if (error) {
      if (error.code === '42501') Alert.alert('Message not sent', 'You can’t message this chat right now. The person may have blocked you, or you were removed from the group.');
      else fail(error);
      return false;
    }
    setReplyTo(null);
    return true;
  };
  const sendText = async () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    let fields = { body };
    if (isGroup) {
      const lk = await lockForGroup(body);
      if (!lk) { setText(body); return; }
      fields = lk;
    } else {
      if (!e2e?.otherPub) { setText(body); return Alert.alert('Can’t send securely yet', 'This person needs to open the latest version of Chat Up first. Messages in one-to-one chats are always encrypted.'); }
      fields = { enc: encText(body, e2e.otherPub, e2e.secret) };
    }
    if (!(await insertMsg(fields))) setText(body);
  };
  const removeMsg = async (m) => {
    const { data, error } = await supabase.rpc('delete_message', { mid: m.id });
    if (error) return fail(error);
    setMsgs((ms) => ms.map((x) => (x.id === m.id ? { ...x, body: null, enc: null, image_path: null, audio_path: null, deleted_at: new Date().toISOString() } : x)));
    if (data?.length) supabase.storage.from('chat-images').remove(data);
  };
  const actions = (m) => {
    if (m.deleted_at) return;
    const buttons = [{ text: 'Reply', onPress: () => setReplyTo(m) }];
    if (m.sender_id === me) buttons.push({ text: 'Delete for everyone', style: 'destructive', onPress: () => removeMsg(m) });
    if (m.sender_id !== me) buttons.push({ text: 'Report', style: 'destructive', onPress: () => setReportMsg({ reportedId: m.sender_id, messageId: m.id, excerpt: m.body || null }) });
    buttons.push({ text: 'Cancel', style: 'cancel' });
    Alert.alert('Message', snippet(m), buttons);
  };
  // Locks a message for every current member of a group. Asks before leaving out anyone who can't receive it.
  const lockForGroup = (text) => new Promise((resolve) => {
    const pubs = e2e?.pubs || {};
    const mine = {};
    members.forEach((x) => { if (pubs[x.id]) mine[x.id] = pubs[x.id]; });
    if (!mine[me]) { Alert.alert('Can’t send securely yet', 'Your encryption key isn’t ready. Close and reopen the app, then try again.'); return resolve(null); }
    const missing = members.filter((x) => !pubs[x.id]);
    const go = () => resolve(lockForMembers(text, mine, e2e.secret));
    if (!missing.length) return go();
    Alert.alert('Some people can’t get this message', `${missing.map((x) => x.name).join(', ')} need${missing.length === 1 ? 's' : ''} the latest Chat Up to receive encrypted messages. Send it to everyone else?`,
      [{ text: 'Cancel', style: 'cancel', onPress: () => resolve(null) }, { text: 'Send anyway', onPress: go }]);
  });
  // Locks the file first (both one-to-one and group chats).
  const sendFile = async (bytes, ext, mime, field) => {
    const path = `${cid}/${Date.now()}.bin`;
    let fields = { [field]: path }, data = bytes, type = mime;
    if (isGroup) {
      const f = lockFile(bytes);
      const lk = await lockForGroup(JSON.stringify({ k: f.key }));
      if (!lk) return;
      data = f.data; type = 'application/octet-stream'; fields = { [field]: path, ...lk };
    } else {
      if (!e2e?.otherPub) return Alert.alert('Can’t send securely yet', 'This person needs to open the latest version of Chat Up first. Files in one-to-one chats are always encrypted.');
      const f = lockFile(bytes);
      data = f.data; type = 'application/octet-stream';
      fields = { [field]: path, enc: encText(JSON.stringify({ k: f.key }), e2e.otherPub, e2e.secret) };
    }
    const up = await supabase.storage.from('chat-images').upload(path, data, { contentType: type });
    if (up.error) return fail(up.error);
    await insertMsg(fields);
  };
  const sendPhoto = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.6 });
    if (r.canceled) return;
    const bytes = new Uint8Array(await (await fetch(r.assets[0].uri)).arrayBuffer());
    const sent = await sendFile(bytes, 'jpg', 'image/jpeg', 'image_path');
    return sent;
  };
  const toggleRec = async () => {
    try {
      if (!recording) {
        const p = await Audio.requestPermissionsAsync();
        if (!p.granted) return Alert.alert('Microphone needed', 'Allow microphone access in your phone settings to send voice notes.');
        await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
        const { recording: r } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
        rec.current = r; setRecording(true);
        return;
      }
      setRecording(false);
      const r = rec.current; rec.current = null;
      await r.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const bytes = new Uint8Array(await (await fetch(r.getURI())).arrayBuffer());
      await sendFile(bytes, 'm4a', 'audio/mp4', 'audio_path');
    } catch (e) { setRecording(false); fail(e); }
  };
  const time = (d) => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <SafeAreaView style={s.screen}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.bar}>
          <Pressable onPress={onBack}><Text style={s.link}>Back</Text></Pressable>
          <Pressable onPress={() => setInfoOpen(true)} accessibilityLabel="Chat info" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}><Avatar name={title} size={32} /><View><Text style={s.h2}>{title}</Text>{typing ? <Text style={{ color: t.acc, fontSize: 12 }}>{isGroup ? 'someone is typing…' : 'typing…'}</Text> : isGroup ? <Text style={{ color: t.mute, fontSize: 12 }}>{count} people</Text> : null}</View></Pressable>
          {!isGroup ? (
            <View style={{ flexDirection: 'row', gap: 16 }}>
              <Pressable onPress={() => (iBlocked ? Alert.alert('Blocked', 'Unblock this person to call them.') : onCall(cid, 'video'))} accessibilityRole="button" accessibilityLabel="Video call"><Text style={{ fontSize: 20, color: t.acc }}>▶</Text></Pressable>
              <Pressable onPress={() => (iBlocked ? Alert.alert('Blocked', 'Unblock this person to call them.') : onCall(cid, 'voice'))} accessibilityRole="button" accessibilityLabel="Voice call"><Text style={{ fontSize: 20, color: t.acc }}>✆</Text></Pressable>
            </View>
          ) : <View style={{ width: 40 }} />}
        </View>
        <FlatList ref={list} style={s.msgs} data={rows} keyExtractor={(m) => String(m.id)} contentContainerStyle={{ padding: 12, gap: 6 }}
          ListHeaderComponent={<Text style={{ alignSelf: 'center', textAlign: 'center', color: t.mute, fontSize: 12, backgroundColor: t.surf, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 8 }}>🔒 Messages, photos and voice notes in this chat are end-to-end encrypted.</Text>}
          onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => {
            if (item.sep) return <Text style={{ alignSelf: 'center', color: t.mute, fontSize: 12, marginVertical: 6 }}>{item.sep}</Text>;
            const mine = item.sender_id === me;
            const q = item.reply_to ? msgs.find((x) => x.id === item.reply_to) : null;
            return (
              <Pressable onLongPress={() => actions(item)} delayLongPress={300} style={[s.msg, mine ? s.out : s.inn]}>
                {isGroup && !mine ? <Text style={{ color: t.acc, fontWeight: '700', fontSize: 12, marginBottom: 2 }}>{names[item.sender_id] || 'Someone'}</Text> : null}
                {item.reply_to ? (
                  <View style={{ borderLeftWidth: 3, borderLeftColor: mine ? '#fff' : t.acc, backgroundColor: 'rgba(0,0,0,0.12)', borderRadius: 8, padding: 6, marginBottom: 4 }}>
                    <Text style={{ fontWeight: '700', fontSize: 12, color: mine ? t.outInk : t.acc }}>{q ? (q.sender_id === me ? 'You' : names[q.sender_id] || 'Someone') : 'Message'}</Text>
                    <Text numberOfLines={2} style={{ fontSize: 13, color: mine ? t.outInk : t.ink }}>{snippet(q)}</Text>
                  </View>
                ) : null}
                {item.deleted_at ? <Text style={{ fontStyle: 'italic', color: mine ? t.outInk : t.mute, fontSize: 15 }}>🚫 This message was deleted</Text>
                  : item.image_path ? <Photo path={item.image_path} fileKey={item.fileKey} locked={!!item.enc && !item.fileKey} /> : item.audio_path ? <VoiceNote path={item.audio_path} mine={mine} fileKey={item.fileKey} locked={!!item.enc && !item.fileKey} /> : <Text style={{ color: mine ? t.outInk : t.ink, fontSize: 16 }}>{item.body}</Text>}
                <Text style={{ fontSize: 11, opacity: 0.65, alignSelf: 'flex-end', marginTop: 2, color: mine ? t.outInk : t.mute }}>{time(item.created_at)}{mine ? (otherRead && new Date(otherRead) >= new Date(item.created_at) ? <Text style={{ color: '#7be0ff' }}> ✓✓</Text> : ' ✓') : ''}</Text>
              </Pressable>
            );
          }} />
        {iBlocked ? <Text style={[s.mute, { textAlign: 'center', padding: 8, backgroundColor: t.surf }]}>You blocked this person. Tap their name above to unblock.</Text> : null}
        {replyTo ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: t.surf, borderTopWidth: 1, borderColor: t.line }}>
            <View style={{ flex: 1, borderLeftWidth: 3, borderLeftColor: t.acc, paddingLeft: 8 }}>
              <Text style={{ color: t.acc, fontWeight: '700', fontSize: 12 }}>Replying to {replyTo.sender_id === me ? 'yourself' : names[replyTo.sender_id] || 'Someone'}</Text>
              <Text numberOfLines={1} style={s.mute}>{snippet(replyTo)}</Text>
            </View>
            <Pressable onPress={() => setReplyTo(null)} accessibilityLabel="Cancel reply"><Text style={s.link}>✕</Text></Pressable>
          </View>
        ) : null}
        <View style={s.row}>
          <Pressable onPress={sendPhoto} style={{ padding: 6 }} accessibilityLabel="Send a photo"><Text style={{ fontSize: 20 }}>📷</Text></Pressable>
          {text.trim() ? null : <Pressable onPress={toggleRec} style={{ padding: 6 }} accessibilityLabel={recording ? 'Stop and send voice note' : 'Record a voice note'}><Text style={{ fontSize: 20 }}>{recording ? '⏹' : '🎤'}</Text></Pressable>}
          <TextInput style={[s.input, { flex: 1, marginVertical: 0 }]} value={text} onChangeText={onType} placeholder={recording ? 'Recording… tap stop to send' : 'Message'} onSubmitEditing={sendText} />
          {text.trim() ? <Pressable onPress={sendText} style={s.go} accessibilityLabel="Send"><Text style={s.btnText}>↑</Text></Pressable> : null}
        </View>
      </KeyboardAvoidingView>
      {reportMsg && <ReportSheet target={reportMsg} onClose={() => setReportMsg(null)} />}
      {infoOpen && <ChatInfo chat={chat} me={me} cid={cid} isGroup={isGroup} title={title} members={members} adminId={adminId} otherId={otherId} iBlocked={iBlocked} setIBlocked={setIBlocked}
        onTitle={setTitle} onClose={() => setInfoOpen(false)} onChanged={loadMembers} onLeft={() => { setInfoOpen(false); onBack(); }} />}
    </SafeAreaView>
  );
}

const ago = (d) => {
  const m = Math.round((Date.now() - new Date(d)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : Math.round(m / 60) + ' h ago';
};

function StatusViewer({ items, me, onClose, onDelete, onSeen }) {
  const { s } = useStyles();
  const [reporting, setReporting] = useState(false);
  const [k, setK] = useState(0);
  const [url, setUrl] = useState(null);
  const [viewers, setViewers] = useState([]);
  const [showViewers, setShowViewers] = useState(false);
  const prog = useRef(new Animated.Value(0)).current;
  const item = items[k];
  const mine = item.user_id === me;
  const loadViewers = () => supabase.from('status_views').select('viewer_id, viewed_at, profiles(name, phone)').eq('status_id', item.id).order('viewed_at', { ascending: false }).then(({ data }) => setViewers(data || []));
  const next = () => (k + 1 < items.length ? setK(k + 1) : onClose());
  const prev = () => setK(Math.max(0, k - 1));
  useEffect(() => {
    setUrl(null);
    onSeen?.(item.id);
    if (item.media_path && item.fileKey) fetchBytes(item.media_path, 'status-media').then((all) => setUrl('data:image/jpeg;base64,' + encodeBase64(unlockFile(all, item.fileKey)))).catch(() => {});
    else if (item.media_path) supabase.storage.from('status-media').createSignedUrl(item.media_path, 3600).then(({ data }) => setUrl(data?.signedUrl));
    setViewers([]);
    if (mine) loadViewers();
    else supabase.from('status_views').upsert({ status_id: item.id }, { onConflict: 'status_id,viewer_id', ignoreDuplicates: true }).then(() => {});
  }, [k]);
  useEffect(() => {
    if (item.kind === 'video') { prog.setValue(1); return; } // videos play to the end; tap Next when ready
    if (showViewers) { prog.stopAnimation(); return; }       // pause while the viewers list is open
    prog.setValue(0);
    Animated.timing(prog, { toValue: 1, duration: 5000, useNativeDriver: false }).start();
    const timer = setTimeout(next, 5000); // text and photos advance by themselves
    return () => { clearTimeout(timer); prog.stopAnimation(); };
  }, [k, showViewers]);
  const player = useVideoPlayer(item.kind === 'video' ? url : null, (p) => { p.play(); });
  const name = mine ? 'My status' : item.profiles?.name || '+' + item.profiles?.phone;
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: '#000' }}>
        <View style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 12, paddingTop: 8 }}>
          {items.map((_, j) => (
            <View key={j} style={{ flex: 1, height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' }}>
              <Animated.View style={{ height: 3, backgroundColor: '#fff', width: j < k ? '100%' : j === k ? prog.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) : '0%' }} />
            </View>
          ))}
        </View>
        <View style={[s.bar, { backgroundColor: '#000', borderColor: '#222' }]}>
          <Pressable onPress={onClose}><Text style={s.link}>Close</Text></Pressable>
          <Text style={{ color: '#fff', fontWeight: '700' }}>{name} · {ago(item.created_at)}</Text>
          {mine ? <Pressable onPress={() => onDelete(item)}><Text style={{ color: '#ff8a8a' }}>Delete</Text></Pressable> : <Pressable onPress={() => setReporting(true)} accessibilityRole="button"><Text style={{ color: '#ff8a8a' }}>Report</Text></Pressable>}
        </View>
        <View style={{ flex: 1, justifyContent: 'center', backgroundColor: item.kind === 'text' ? AV[item.bg % AV.length] : '#000' }}>
          {item.kind === 'text' && <Text style={{ color: '#fff', fontSize: 28, fontWeight: '700', textAlign: 'center', padding: 24 }}>{item.body}</Text>}
          {item.kind === 'photo' && (url ? <Image source={{ uri: url }} style={{ flex: 1 }} resizeMode="contain" /> : <Text style={{ color: '#fff', textAlign: 'center' }}>Loading…</Text>)}
          {item.kind === 'video' && (url ? <VideoView player={player} style={{ flex: 1 }} nativeControls allowsFullscreen /> : <Text style={{ color: '#fff', textAlign: 'center' }}>Loading…</Text>)}
        </View>
        {item.kind !== 'text' && item.body ? <Text style={{ color: '#fff', paddingHorizontal: 14, paddingTop: 10 }}>{item.body}</Text> : null}
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: 14 }}>
          <Pressable onPress={prev}><Text style={s.link}>‹ Previous</Text></Pressable>
          {mine ? <Pressable onPress={() => { loadViewers(); setShowViewers(true); }} accessibilityLabel="Who viewed this status"><Text style={s.link}>👁 {viewers.length}</Text></Pressable> : null}
          <Pressable onPress={next}><Text style={s.link}>{k + 1 < items.length ? 'Next ›' : 'Done'}</Text></Pressable>
        </View>
        {showViewers && (
          <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '60%', backgroundColor: '#181a31', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 16 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: 16 }}>
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>Viewed by {viewers.length}</Text>
              <Pressable onPress={() => setShowViewers(false)} accessibilityLabel="Close viewers list"><Text style={s.link}>Close</Text></Pressable>
            </View>
            <ScrollView>
              {!viewers.length ? <Text style={{ color: '#9a9fc2', paddingHorizontal: 16, paddingBottom: 12 }}>No one has viewed this yet.</Text> : null}
              {viewers.map((v) => (
                <View key={v.viewer_id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 8 }}>
                  <Avatar name={v.profiles?.name || v.profiles?.phone || '?'} size={36} round />
                  <Text style={{ color: '#fff', flex: 1 }}>{v.profiles?.name || (v.profiles?.phone ? '+' + v.profiles.phone : 'Someone')}</Text>
                  <Text style={{ color: '#9a9fc2', fontSize: 12 }}>{ago(v.viewed_at)}</Text>
                </View>
              ))}
            </ScrollView>
          </View>
        )}
        {reporting && <ReportSheet target={{ reportedId: item.user_id, statusId: item.id, excerpt: item.kind === 'text' ? item.body : null }} onClose={() => setReporting(false)} />}
      </SafeAreaView>
    </Modal>
  );
}

const FONT_STYLES = [undefined, Platform.select({ ios: 'Georgia', android: 'serif' }), Platform.select({ ios: 'Menlo', android: 'monospace' })];
const fmt = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;

// Really cuts the file. Needs the react-native-video-trim native module, which only exists in a development/production build
// (not Expo Go or Snack). Returns the new file's path, or null when cutting isn't possible. The exact options may differ by
// library version: check its current docs when you first build.
async function cutVideo(uri, startS, endS) {
  try {
    const { trim } = require('react-native-video-trim');
    const out = await trim(uri, { startTime: Math.round(startS * 1000), endTime: Math.round(endS * 1000) });
    return typeof out === 'string' ? out : out?.outputPath || null;
  } catch (e) { return null; }
}

function AudienceSheet({ audience, ids, onDone, onClose }) {
  const { t, s } = useStyles();
  const [mode, setMode] = useState(audience);
  const [sel, setSel] = useState(ids);
  const [contacts, setContacts] = useState(null);
  useEffect(() => {
    supabase.rpc('my_contacts').then(({ data, error }) => {
      if (error) { fail(error); setContacts([]); } else setContacts(data || []);
    });
  }, []);
  const opts = [['all', 'My contacts', 'Everyone you share a chat with'], ['except', 'My contacts except…', 'Hide it from the people you pick'], ['only', 'Only share with…', 'Show it only to the people you pick']];
  const toggle = (id) => setSel((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const done = () => {
    if (mode === 'only' && !sel.length) return Alert.alert('Choose people', 'Pick at least one person, or choose My contacts.');
    onDone(mode, mode === 'all' ? [] : sel);
  };
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.screen}>
        <View style={s.bar}><Pressable onPress={onClose}><Text style={s.link}>Cancel</Text></Pressable><Text style={s.h2}>Status privacy</Text><Pressable onPress={done}><Text style={s.link}>Done</Text></Pressable></View>
        {opts.map(([k, l, d]) => (
          <Pressable key={k} onPress={() => setMode(k)} accessibilityRole="radio" accessibilityState={{ selected: mode === k }} style={s.chatRow}>
            <Text style={{ fontSize: 22, color: t.acc }}>{mode === k ? '◉' : '○'}</Text>
            <View style={{ flex: 1 }}><Text style={s.name}>{l}</Text><Text style={s.mute}>{d}</Text></View>
          </Pressable>
        ))}
        {mode !== 'all' ? (
          <ScrollView style={s.list}>
            <Text style={[s.mute, { padding: 16, paddingBottom: 6, fontWeight: '700' }]}>{mode === 'except' ? 'Hide from' : 'Share with'} ({sel.length})</Text>
            {contacts && !contacts.length ? <Text style={[s.mute, { padding: 16 }]}>You have no contacts yet. Start a chat first.</Text> : null}
            {(contacts || []).map((c) => (
              <Pressable key={c.user_id} onPress={() => toggle(c.user_id)} accessibilityRole="checkbox" accessibilityState={{ checked: sel.includes(c.user_id) }} style={s.chatRow}>
                <Text style={{ fontSize: 22, color: t.acc }}>{sel.includes(c.user_id) ? '☑' : '☐'}</Text>
                <Text style={[s.name, { flex: 1 }]}>{c.name || '+' + c.phone}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : <View style={{ flex: 1 }} />}
      </SafeAreaView>
    </Modal>
  );
}

function RoundBtn({ label, onPress, a11y }) {
  return (
    <Pressable onPress={onPress} accessibilityLabel={a11y} style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(120,110,100,0.7)', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>{label}</Text>
    </Pressable>
  );
}
const soon = (what) => Alert.alert('Coming soon', `${what} isn’t built yet.`);

function StatusComposer({ me, onClose, onPosted, asset }) {
  const { s } = useStyles();
  const [text, setText] = useState('');
  const [bg, setBg] = useState(0);
  const [font, setFont] = useState(0);
  const [media, setMedia] = useState(null); // { kind, uri, orig, w, h, ow, oh, dur, size }
  const [vs, setVs] = useState(0);
  const [ve, setVe] = useState(0);
  const [thumbs, setThumbs] = useState([]);
  const [filmW, setFilmW] = useState(0);
  const [showEdit, setShowEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [audience, setAudience] = useState('all');
  const [audIds, setAudIds] = useState([]);
  const [audOpen, setAudOpen] = useState(false);
  const audLabel = audience === 'all' ? '◎ Status (all contacts) ⟲' : audience === 'except' ? `◎ Status (${audIds.length} excluded) ⟲` : `◎ Status (only ${audIds.length}) ⟲`;
  const saveStatus = async (row) => {
    let enc = {};
    if (row.kind !== 'video') { // text and photos are locked for each allowed viewer
      const l = await lockStatus({ b: row.body ?? null, k: row.fileKey ?? null }, audience, audIds, me);
      enc = { p_enc: l.enc, p_enc_keys: l.enc_keys };
      if (l.missing) Alert.alert('Some people can’t see this', `${l.missing} ${l.missing === 1 ? 'person needs' : 'people need'} the latest Chat Up to see encrypted statuses.`);
    }
    const { error } = await supabase.rpc('post_status', {
      p_kind: row.kind, p_body: row.kind === 'video' ? (row.body ?? null) : null, p_media_path: row.media_path ?? null, p_bg: row.bg ?? 0, p_duration: row.duration_s ?? null,
      p_audience: audience, p_audience_ids: audience === 'all' ? [] : audIds, ...enc,
    });
    if (error) throw error;
  };
  const player = useVideoPlayer(media?.kind === 'video' ? media.uri : null, (p) => { p.loop = true; p.play(); });
  const playerR = useRef(null); playerR.current = player;
  useEffect(() => { if (asset) applyAsset(asset, asset.type === 'video'); }, []);
  const vsR = useRef(0), veR = useRef(0), durR = useRef(0), wR = useRef(0), g0 = useRef(0);
  const setS = (v) => { vsR.current = v; setVs(v); try { playerR.current.currentTime = v; } catch (e) {} };
  const setE = (v) => { veR.current = v; setVe(v); };
  const panL = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { g0.current = vsR.current; },
    onPanResponderMove: (_, g) => {
      let v = Math.max(0, Math.min(g0.current + (g.dx / (wR.current || 1)) * durR.current, veR.current - 0.5));
      if (veR.current - v > 1800) v = veR.current - 1800;
      setS(v);
    },
  })).current;
  const panR = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { g0.current = veR.current; },
    onPanResponderMove: (_, g) => {
      let v = Math.min(durR.current, Math.max(g0.current + (g.dx / (wR.current || 1)) * durR.current, vsR.current + 0.5));
      if (v - vsR.current > 1800) v = vsR.current + 1800;
      setE(v);
      try { playerR.current.currentTime = Math.max(vsR.current, v - 1); } catch (e) {}
    },
  })).current;
  useEffect(() => { // keep the preview inside the kept part
    if (media?.kind !== 'video') return;
    const id = setInterval(() => { try { if (player.currentTime >= ve) player.currentTime = vs; } catch (e) {} }, 250);
    return () => clearInterval(id);
  }, [media, vs, ve, player]);
  useEffect(() => { // filmstrip frames
    if (media?.kind !== 'video') { setThumbs([]); return; }
    let live = true; setThumbs([]);
    (async () => {
      for (let i = 0; i < 10; i++) {
        try {
          const r = await VideoThumbnails.getThumbnailAsync(media.uri, { time: Math.floor(((i + 0.5) / 10) * media.dur * 1000), quality: 0.3 });
          if (!live) return;
          setThumbs((t) => [...t, r.uri]);
        } catch (e) { if (!live) return; }
      }
    })();
    return () => { live = false; };
  }, [media?.uri]);

  const applyAsset = (a, video) => { // a: { uri, type, width, height, duration (ms), fileSize }
    if (video) {
      const d = (a.duration || 0) / 1000;
      durR.current = d; vsR.current = 0; veR.current = Math.min(d, 1800);
      setMedia({ kind: 'video', uri: a.uri, dur: d, size: a.fileSize || 0, w: a.width, h: a.height }); setVs(0); setVe(Math.min(d, 1800));
      if (d > 1800) Alert.alert('Longer than 30 minutes', 'Trim it to 30 minutes or less before posting.');
    } else { setShowEdit(false); setMedia({ kind: 'photo', uri: a.uri, orig: a.uri, w: a.width, h: a.height, ow: a.width, oh: a.height }); }
  };
  const pick = async (kind) => { // 'photo', 'video' or 'any'
    const mt = kind === 'video' ? ImagePicker.MediaTypeOptions.Videos : kind === 'photo' ? ImagePicker.MediaTypeOptions.Images : ImagePicker.MediaTypeOptions.All;
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: mt, quality: 0.8 });
    if (r.canceled) return;
    const a = r.assets[0];
    applyAsset(a, kind === 'video' || a.type === 'video');
  };
  const edit = async (actions) => {
    const r = await ImageManipulator.manipulateAsync(media.uri, actions, { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG });
    setMedia({ ...media, uri: r.uri, w: r.width, h: r.height });
  };
  const square = () => { const m = Math.min(media.w, media.h); return edit([{ crop: { originX: (media.w - m) / 2, originY: (media.h - m) / 2, width: m, height: m } }]); };

  const upload = async (uri, video, secs, caption) => {
    if (video) {
      const ok = await new Promise((res) => Alert.alert('Video statuses aren’t encrypted yet', 'Text and photo statuses are end-to-end encrypted. Videos are too large for that for now, so the server can read this one. Post it anyway?', [{ text: 'Cancel', style: 'cancel', onPress: () => res(false) }, { text: 'Post video', onPress: () => res(true) }]));
      if (!ok) return;
    }
    setBusy(true);
    try {
      if (video) {
        const path = `${me}/${Date.now()}.mp4`;
        const fd = new FormData(); // streamed from disk, not loaded into memory
        fd.append('file', { uri, name: 'status.mp4', type: 'video/mp4' });
        const up = await supabase.storage.from('status-media').upload(path, fd);
        if (up.error) throw up.error;
        await saveStatus({ kind: 'video', media_path: path, duration_s: secs, body: caption || null });
      } else {
        const bytes = new Uint8Array(await (await fetch(uri)).arrayBuffer()); // photos are small enough to lock in memory
        const f = lockFile(bytes);
        const path = `${me}/${Date.now()}.bin`;
        const up = await supabase.storage.from('status-media').upload(path, f.data, { contentType: 'application/octet-stream' });
        if (up.error) throw up.error;
        await saveStatus({ kind: 'photo', media_path: path, body: caption || null, fileKey: f.key });
      }
      onPosted?.(); onClose();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const post = async () => {
    const body = text.trim();
    if (media && audience === 'only' && !audIds.length) return Alert.alert('Choose people', 'Pick who can see this status.');
    if (!media) {
      if (!body) return Alert.alert('Add something', 'Type a status, or add a photo or video.');
      if (audience === 'only' && !audIds.length) return Alert.alert('Choose people', 'Pick who can see this status.');
      setBusy(true);
      try { await saveStatus({ kind: 'text', body, bg }); } catch (e) { setBusy(false); return fail(e); }
      setBusy(false);
      onPosted?.(); return onClose();
    }
    if (media.kind === 'photo') return upload(media.uri, false, null, body);
    if (ve - vs > 1800) return Alert.alert('Too long', 'Trim the video to 30 minutes or less.');
    if (!(vs > 0.5 || ve < media.dur - 0.5)) return upload(media.uri, true, Math.round(media.dur), body);
    setBusy(true);
    const out = await cutVideo(media.uri, vs, ve);
    setBusy(false);
    if (out) return upload(out, true, Math.round(ve - vs), body);
    const over = media.dur > 1800;
    Alert.alert('Cutting isn’t available here', 'Cutting a video needs the full app build, not Expo Go or Snack.' + (over ? ' This video is over 30 minutes, so it can’t be posted without cutting.' : ' You can post the whole video instead.'),
      over ? [{ text: 'OK' }] : [{ text: 'Cancel', style: 'cancel' }, { text: 'Post whole video', onPress: () => upload(media.uri, true, Math.round(media.dur), body) }]);
  };

  const white = { color: '#fff' };
  const chip = { backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 8 };
  const pill = { backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 };
  const sendBtn = (size, bgc, fg) => (
    <Pressable onPress={post} disabled={busy} accessibilityLabel="Post status" style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bgc, alignItems: 'center', justifyContent: 'center', opacity: busy ? 0.5 : 1 }}>
      <Text style={{ color: fg, fontSize: 22 }}>➤</Text>
    </Pressable>
  );

  if (media) {
    const dur = media.dur || 1;
    const wide = media.w && media.h && media.w >= media.h ? 'contain' : 'cover'; // tall media fills the screen; wide media fills the full width
    const mb = (((media.size || 0) * (ve - vs)) / dur / 1048576).toFixed(1);
    return (
      <Modal visible animationType="slide" onRequestClose={onClose}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          {media.kind === 'photo'
            ? <Image source={{ uri: media.uri }} style={StyleSheet.absoluteFill} resizeMode={wide} />
            : <Pressable style={StyleSheet.absoluteFill} onPress={() => { try { player.playing ? player.pause() : player.play(); } catch (e) {} }}><VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} contentFit={wide} /></Pressable>}
        <SafeAreaView style={{ flex: 1 }} pointerEvents="box-none">
          <KeyboardAvoidingView style={{ flex: 1 }} pointerEvents="box-none" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 }}>
              <RoundBtn label="✕" a11y="Close" onPress={onClose} />
              <View style={{ flex: 1 }} />
              <RoundBtn label="♪" a11y="Music" onPress={() => soon('Music')} />
              {media.kind === 'photo' && <RoundBtn label="⟳" a11y="Rotate and crop" onPress={() => setShowEdit(!showEdit)} />}
              <RoundBtn label="☺" a11y="Stickers" onPress={() => soon('Stickers')} />
              <RoundBtn label="Aa" a11y="Add text" onPress={() => soon('Text on photos and videos')} />
              <RoundBtn label="✎" a11y="Draw" onPress={() => soon('Drawing')} />
            </View>
            {media.kind === 'video' && (
              <View style={{ paddingHorizontal: 20 }}>
                <View style={{ height: 56, marginTop: 6 }} onLayout={(e) => { wR.current = e.nativeEvent.layout.width; setFilmW(e.nativeEvent.layout.width); }}>
                  <View style={{ flex: 1, flexDirection: 'row', borderWidth: 2, borderColor: '#fff', borderRadius: 4, overflow: 'hidden', backgroundColor: '#222' }}>
                    {thumbs.map((u, i) => <Image key={i} source={{ uri: u }} style={{ flex: 1, height: '100%' }} />)}
                  </View>
                  <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: (filmW * vs) / dur, backgroundColor: 'rgba(0,0,0,0.6)' }} />
                  <View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, right: 0, left: (filmW * ve) / dur, backgroundColor: 'rgba(0,0,0,0.6)' }} />
                  <View {...panL.panHandlers} accessibilityLabel="Trim start" style={{ position: 'absolute', top: 15, left: (filmW * vs) / dur - 13, width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff' }} />
                  <View {...panR.panHandlers} accessibilityLabel="Trim end" style={{ position: 'absolute', top: 15, left: (filmW * ve) / dur - 13, width: 26, height: 26, borderRadius: 13, backgroundColor: '#fff' }} />
                </View>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                  <View style={pill}><Text style={white}>{fmt(ve - vs)} • {mb} MB</Text></View>
                </View>
              </View>
            )}
            <View style={{ flex: 1 }} pointerEvents="none" />
            <View style={{ padding: 12, backgroundColor: 'rgba(0,0,0,0.3)' }}>
              {media.kind === 'photo' && showEdit && (
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                  <Pressable style={chip} onPress={() => edit([{ rotate: 90 }])}><Text style={white}>↻ Rotate</Text></Pressable>
                  <Pressable style={chip} onPress={square}><Text style={white}>▢ Square</Text></Pressable>
                  <Pressable style={chip} onPress={() => setMedia({ ...media, uri: media.orig, w: media.ow, h: media.oh })}><Text style={white}>Reset</Text></Pressable>
                </View>
              )}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#12161f', borderRadius: 26, paddingHorizontal: 16 }}>
                <Text style={{ fontSize: 20 }}>🖼</Text>
                <TextInput value={text} onChangeText={setText} maxLength={140} placeholder="Add a caption…" placeholderTextColor="rgba(255,255,255,0.75)" style={{ flex: 1, color: '#fff', fontSize: 17, paddingVertical: 14 }} />
                <Text style={[white, { fontSize: 20 }]}>@</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 }}>
                <Pressable onPress={() => setAudOpen(true)} accessibilityLabel="Who can see this status" style={[pill, { backgroundColor: 'rgba(255,255,255,0.14)' }]}>
                  <Text style={white}>{audLabel}</Text>
                </Pressable>
                {busy ? <Text style={white}>Uploading…</Text> : null}
                {sendBtn(58, '#fff', '#111')}
              </View>
            </View>
          </KeyboardAvoidingView>
        </SafeAreaView>
        {audOpen && <AudienceSheet audience={audience} ids={audIds} onClose={() => setAudOpen(false)} onDone={(a, i) => { setAudience(a); setAudIds(i); setAudOpen(false); }} />}
        </View>
      </Modal>
    );
  }
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: AV[bg % 4] }}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12 }}>
            <Pressable onPress={onClose} accessibilityLabel="Close"><Text style={[white, { fontSize: 22 }]}>✕</Text></Pressable>
            <View style={{ flex: 1 }} />
            <Pressable onPress={() => setFont((font + 1) % 3)} accessibilityLabel="Change font" style={{ padding: 8 }}><Text style={[white, { fontSize: 20 }]}>Aa</Text></Pressable>
            <Pressable onPress={() => setBg((bg + 1) % 4)} accessibilityLabel="Change background color" style={{ padding: 8 }}><Text style={{ fontSize: 20 }}>🎨</Text></Pressable>
          </View>
          <View style={{ flex: 1, justifyContent: 'center' }}>
            <TextInput multiline maxLength={140} value={text} onChangeText={setText} placeholder="Type a status" placeholderTextColor="rgba(255,255,255,0.7)" style={{ color: '#fff', fontSize: 30, fontWeight: '700', textAlign: 'center', padding: 24, fontFamily: FONT_STYLES[font] }} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, padding: 12, backgroundColor: 'rgba(0,0,0,0.25)' }}>
            <Pressable onPress={() => pick('photo')} accessibilityLabel="Add photo" style={{ padding: 8 }}><Text style={{ fontSize: 24 }}>📷</Text></Pressable>
            <Pressable onPress={() => pick('video')} accessibilityLabel="Add video" style={{ padding: 8 }}><Text style={{ fontSize: 24 }}>🎬</Text></Pressable>
            <Pressable onPress={() => setAudOpen(true)} accessibilityLabel="Who can see this status" style={[pill, { backgroundColor: 'rgba(255,255,255,0.14)', flex: 1 }]}><Text style={white} numberOfLines={1}>{audLabel}</Text></Pressable>
            {sendBtn(52, '#5448ee', '#fff')}
          </View>
        </KeyboardAvoidingView>
        {audOpen && <AudienceSheet audience={audience} ids={audIds} onClose={() => setAudOpen(false)} onDone={(a, i) => { setAudience(a); setAudIds(i); setAudOpen(false); }} />}
      </SafeAreaView>
    </Modal>
  );
}

function AddStatusSheet({ onClose, onText, onAsset }) {
  const { t, s } = useStyles();
  const size = useWindowDimensions().width / 3;
  const [granted, setGranted] = useState(null);
  const [assets, setAssets] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const p = await MediaLibrary.requestPermissionsAsync();
        if (!p.granted) return setGranted(false);
        setGranted(true);
        const r = await MediaLibrary.getAssetsAsync({ first: 60, mediaType: ['photo', 'video'], sortBy: [MediaLibrary.SortBy.creationTime] });
        setAssets(r.assets);
      } catch (e) { setGranted(false); }
    })();
  }, []);
  const camera = async () => {
    const p = await ImagePicker.requestCameraPermissionsAsync();
    if (!p.granted) return Alert.alert('Camera needed', 'Allow camera access in your phone settings to take a photo or video.');
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, quality: 0.8 });
    if (!r.canceled) onAsset(r.assets[0]);
  };
  const gallery = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, quality: 0.8 });
    if (!r.canceled) onAsset(r.assets[0]);
  };
  const choose = async (a) => {
    try {
      const info = await MediaLibrary.getAssetInfoAsync(a); // gives a file path the editor can open on iPhone
      onAsset({ uri: info.localUri || a.uri, type: a.mediaType === 'video' ? 'video' : 'image', width: a.width, height: a.height, duration: (a.duration || 0) * 1000, fileSize: info.fileSize });
    } catch (e) { fail(e); }
  };
  const Round = ({ icon, label, onPress }) => (
    <Pressable onPress={onPress} accessibilityLabel={label} style={{ alignItems: 'center', gap: 8 }}>
      <View style={{ width: 78, height: 60, borderRadius: 30, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 24, color: t.ink }}>{icon}</Text></View>
      <Text style={{ color: t.ink }}>{label}</Text>
    </Pressable>
  );
  const data = [{ id: 'camera' }, ...assets];
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.screen}>
        <View style={s.bar}>
          <Pressable onPress={onClose} accessibilityLabel="Close"><Text style={[s.h2, { fontWeight: '400' }]}>✕</Text></Pressable>
          <Text style={s.h2}>Add status</Text>
          <View style={{ width: 24 }} />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 28, paddingVertical: 18 }}>
          <Round icon="✎" label="Text" onPress={onText} />
          <Round icon="▦" label="Layout" onPress={() => soon('Layout')} />
          <Round icon="🎤" label="Voice" onPress={() => soon('Voice statuses')} />
        </View>
        <Text style={[s.mute, { fontWeight: '700', paddingHorizontal: 16, paddingBottom: 8 }]}>Recents ▾</Text>
        {granted === false && (
          <View style={{ paddingHorizontal: 16 }}>
            <Text style={s.mute}>Allow photo access to see your recent photos and videos here.</Text>
            <Btn label="Choose from gallery" onPress={gallery} />
          </View>
        )}
        <FlatList
          style={s.list}
          data={data}
          numColumns={3}
          keyExtractor={(i) => i.id}
          renderItem={({ item }) => item.id === 'camera' ? (
            <Pressable onPress={camera} accessibilityLabel="Camera" style={{ width: size, height: size, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: t.surf }}>
              <Text style={{ fontSize: 30 }}>📷</Text><Text style={s.mute}>Camera</Text>
            </Pressable>
          ) : (
            <Pressable onPress={() => choose(item)} accessibilityLabel={item.mediaType === 'video' ? 'Video' : 'Photo'} style={{ width: size, height: size, borderWidth: 1, borderColor: t.surf }}>
              <Image source={{ uri: item.uri }} style={{ flex: 1 }} />
              {item.mediaType === 'video' ? <Text style={{ position: 'absolute', left: 6, bottom: 4, color: '#fff', fontWeight: '700', textShadowColor: '#000', textShadowRadius: 3 }}>🎬 {fmt(item.duration || 0)}</Text> : null}
            </Pressable>
          )}
        />
      </SafeAreaView>
    </Modal>
  );
}

// Add status flow: the sheet first, then the editor for whatever was chosen. direct="text" skips the sheet.
function StatusFlow({ me, onClose, onPosted, direct }) {
  const [step, setStep] = useState(direct === 'text' ? { text: true } : null);
  if (step) return <StatusComposer me={me} asset={step.asset} onClose={onClose} onPosted={onPosted} />;
  return <AddStatusSheet onClose={onClose} onText={() => setStep({ text: true })} onAsset={(asset) => setStep({ asset })} />;
}

function StatusCard({ c, onPress }) {
  const last = c.items[c.items.length - 1];
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (last.kind === 'photo' && last.fileKey) fetchBytes(last.media_path, 'status-media').then((all) => setUrl('data:image/jpeg;base64,' + encodeBase64(unlockFile(all, last.fileKey)))).catch(() => {});
    else if (last.kind === 'photo' && !last.locked) supabase.storage.from('status-media').createSignedUrl(last.media_path, 3600).then(({ data }) => setUrl(data?.signedUrl));
  }, [last.id, last.fileKey]);
  const label = last.kind === 'text' ? last.body : last.kind === 'video' ? '🎬 Video' : '';
  return (
    <Pressable onPress={onPress} accessibilityLabel={`${c.name} status`} style={{ width: 114, height: 200, borderRadius: 20, overflow: 'hidden', backgroundColor: last.kind === 'text' ? AV[last.bg % 4] : '#222', justifyContent: 'flex-end', padding: 10 }}>
      {url ? <Image source={{ uri: url }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
      <View style={{ position: 'absolute', top: 12, left: 12, padding: 2, borderRadius: 30, borderWidth: 3, borderColor: c.unseen ? '#fff' : 'rgba(255,255,255,0.4)' }}>
        <Avatar name={c.avatar || c.name} size={44} round />
      </View>
      {label ? <Text numberOfLines={5} style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{label}</Text> : null}
      <Text numberOfLines={2} style={{ color: '#fff', fontWeight: '700', fontSize: 14, marginTop: 6 }}>{c.name}</Text>
    </Pressable>
  );
}

function Updates({ me, profile }) {
  const { t, s } = useStyles();
  const [rows, setRows] = useState([]);
  const [seen, setSeen] = useState([]);
  const [story, setStory] = useState(null);
  const [composer, setComposer] = useState(null); // null, 'text' or 'any'
  const load = async () => {
    const { data, error } = await supabase.from('statuses').select('*, profiles(name, phone)').gt('expires_at', new Date().toISOString()).order('created_at');
    error ? fail(error) : setRows(await decryptStatuses(data, me));
  };
  useEffect(() => {
    load();
    AsyncStorage.getItem('chatup.seen').then((v) => { if (v) setSeen(JSON.parse(v)); });
  }, []);
  const markSeen = (id) => setSeen((p) => {
    if (p.includes(id)) return p;
    const n = [...p, id].slice(-500);
    AsyncStorage.setItem('chatup.seen', JSON.stringify(n));
    return n;
  });
  const { mine, others } = useMemo(() => {
    const by = {};
    rows.forEach((r) => { if (!by[r.user_id]) by[r.user_id] = []; by[r.user_id].push(r); });
    const list = Object.keys(by).filter((id) => id !== me).map((id) => ({
      user_id: id, items: by[id], name: by[id][0].profiles?.name || '+' + by[id][0].profiles?.phone, unseen: by[id].some((i) => !seen.includes(i.id)),
    })).sort((a, b) => Number(b.unseen) - Number(a.unseen));
    return { mine: by[me] || [], others: list };
  }, [rows, seen]);
  const remove = async (it) => {
    if (it.media_path) await supabase.storage.from('status-media').remove([it.media_path]);
    const { error } = await supabase.from('statuses').delete().eq('id', it.id);
    if (error) fail(error);
    setStory(null); load();
  };
  return (
    <SafeAreaView style={s.screen}>
      <View style={s.bar}><Text style={s.h2}>Updates</Text><View style={{ width: 40 }} /></View>
      <ScrollView style={s.list} contentContainerStyle={{ paddingBottom: 160 }}>
        <Text style={[s.h2, { fontSize: 22, padding: 16, paddingBottom: 10 }]}>Status</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 10 }}>
          <Pressable onPress={() => setComposer('sheet')} accessibilityLabel="Add status" style={{ width: 114, height: 200, borderRadius: 20, borderWidth: 1, borderColor: t.line, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'flex-end', padding: 10 }}>
            <View style={{ position: 'absolute', top: 34 }}>
              <Avatar name={profile.name} size={64} round />
              <Pressable onPress={() => setComposer('sheet')} accessibilityLabel="New status" style={{ position: 'absolute', right: -6, bottom: -4, width: 26, height: 26, borderRadius: 13, backgroundColor: t.acc, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: t.bg }}>
                <Text style={{ color: t.accInk, fontWeight: '700', lineHeight: 18 }}>+</Text>
              </Pressable>
            </View>
            <Text style={s.name}>Add status</Text>
          </Pressable>
          {mine.length ? <StatusCard c={{ name: 'My status', avatar: profile.name, items: mine, unseen: true }} onPress={() => setStory(mine)} /> : null}
          {others.map((c) => <StatusCard key={c.user_id} c={c} onPress={() => setStory(c.items)} />)}
        </ScrollView>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, paddingTop: 24 }}>
          <Text style={[s.h2, { fontSize: 22 }]}>Channels</Text>
          <Pressable onPress={() => soon('Channels')} style={{ backgroundColor: t.bg, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 8 }}><Text style={s.name}>Explore</Text></Pressable>
        </View>
        <Text style={[s.mute, { paddingHorizontal: 16 }]}>Channels are coming later. They’ll show news and updates from accounts you follow.</Text>
      </ScrollView>
      <View style={{ position: 'absolute', right: 18, bottom: 24, alignItems: 'flex-end', gap: 12 }}>
        <Pressable onPress={() => setComposer('text')} accessibilityLabel="New text status" style={{ width: 56, height: 56, borderRadius: 18, backgroundColor: t.bg, borderWidth: 1, borderColor: t.line, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 22, color: t.ink }}>✎</Text></Pressable>
        <Pressable onPress={() => setComposer('sheet')} accessibilityLabel="New photo or video status" style={{ width: 64, height: 64, borderRadius: 20, backgroundColor: t.acc, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 24 }}>📷</Text></Pressable>
      </View>
      {composer && <StatusFlow me={me} direct={composer === 'text' ? 'text' : undefined} onClose={() => setComposer(null)} onPosted={load} />}
      {story && <StatusViewer items={story} me={me} onSeen={markSeen} onClose={() => { setStory(null); load(); }} onDelete={remove} />}
    </SafeAreaView>
  );
}

function CallBody({ kind, otherName, isCaller, safety, onEnd }) {
  const { t, s } = useStyles();
  const room = LK.useRoomContext();
  const parts = LK.useParticipants();
  const tracks = LK.useTracks([LKC.Track.Source.Camera]);
  const { localParticipant } = LK.useLocalParticipant();
  const [muted, setMuted] = useState(false);
  const [camOn, setCamOn] = useState(kind === 'video');
  const [secs, setSecs] = useState(0);
  const joined = parts.length > 1;
  const everJoined = useRef(false);
  useEffect(() => { if (joined) everJoined.current = true; }, [joined]);
  // Other person left after joining: the call is over.
  useEffect(() => { if (everJoined.current && !joined) onEnd(true); }, [joined]);
  // The caller gives up after 45 seconds without an answer.
  useEffect(() => {
    if (joined || !isCaller) return;
    const to = setTimeout(() => { room.disconnect(); onEnd('timeout'); }, 45000);
    return () => clearTimeout(to);
  }, [joined]);
  useEffect(() => { if (!joined) return; const i = setInterval(() => setSecs((x) => x + 1), 1000); return () => clearInterval(i); }, [joined]);
  const remote = tracks.find((x) => !x.participant.isLocal && LK.isTrackReference(x));
  const mine = tracks.find((x) => x.participant.isLocal && LK.isTrackReference(x));
  const mm = String(Math.floor(secs / 60)).padStart(2, '0') + ':' + String(secs % 60).padStart(2, '0');
  const Round = ({ icon, label: l, onPress, red, on }) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={l} style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: red ? '#e5484d' : on ? '#fff' : 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ fontSize: 24, color: on ? '#16182b' : '#fff' }}>{icon}</Text>
    </Pressable>
  );
  return (
    <View style={{ flex: 1, backgroundColor: '#0f1020' }}>
      {remote ? <LK.VideoTrack trackRef={remote} style={StyleSheet.absoluteFill} objectFit="cover" /> : null}
      <SafeAreaView style={{ flex: 1, alignItems: 'center', padding: 20 }}>
        {!remote ? <View style={{ marginTop: 80, alignItems: 'center' }}><Avatar name={otherName} size={120} round /></View> : null}
        <Text style={{ color: '#fff', fontSize: 26, fontWeight: '700', marginTop: remote ? 12 : 20, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 4 }}>{otherName}</Text>
        <Text style={{ color: '#dfe1ff', marginTop: 4 }}>{joined ? mm : 'Calling…'}</Text>
        <Pressable onPress={() => Alert.alert('End-to-end encrypted', `Only you and ${otherName} can hear or see this call. To check no one is in the middle, read this number to each other. It must match on both phones:

${safety}`)} accessibilityRole="button" accessibilityLabel="Encryption details" style={{ marginTop: 8, backgroundColor: 'rgba(255,255,255,0.16)', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4 }}>
          <Text style={{ color: '#fff', fontSize: 12 }}>🔒 End-to-end encrypted · Verify</Text>
        </Pressable>
        {mine && camOn ? <View style={{ position: 'absolute', right: 16, top: 90, width: 100, height: 140, borderRadius: 14, overflow: 'hidden' }}><LK.VideoTrack trackRef={mine} style={{ flex: 1 }} objectFit="cover" /></View> : null}
        <View style={{ flex: 1 }} />
        <View style={{ flexDirection: 'row', gap: 18, marginBottom: 24 }}>
          <Round icon={muted ? '🔇' : '🎤'} label={muted ? 'Unmute' : 'Mute'} on={muted} onPress={() => { localParticipant.setMicrophoneEnabled(muted); setMuted(!muted); }} />
          {kind === 'video' ? <Round icon="📷" label={camOn ? 'Turn camera off' : 'Turn camera on'} on={!camOn} onPress={() => { localParticipant.setCameraEnabled(!camOn); setCamOn(!camOn); }} /> : null}
          <Round icon="✆" label="End call" red onPress={() => { room.disconnect(); onEnd(false); }} />
        </View>
      </SafeAreaView>
    </View>
  );
}

function LiveCall({ call, url, token, otherName, e2eeKey, safety, onEnd }) {
  const { e2eeManager } = LK.useRNE2EEManager({ sharedKey: e2eeKey, dataChannelEncryption: true });
  const options = useMemo(() => ({ encryption: { e2eeManager } }), [e2eeManager]);
  useEffect(() => {
    LK.AudioSession.startAudioSession();
    return () => { LK.AudioSession.stopAudioSession(); };
  }, []);
  return (
    <LK.LiveKitRoom serverUrl={url} token={token} connect options={options} audio video={call.kind === 'video'} onDisconnected={() => onEnd(false)} onError={(e) => { fail(e); onEnd(false); }}>
      <CallBody kind={call.kind} otherName={otherName} isCaller={call.caller === call.me} safety={safety} onEnd={onEnd} />
    </LK.LiveKitRoom>
  );
}

function CallScreen({ call, url, token, otherName, otherAllowsRecording, e2eeKey, safety, onEnd }) {
  const { s } = useStyles();
  if (!LK || !LKC) {
    return (
      <Modal visible animationType="slide" onRequestClose={() => onEnd(false)}>
        <SafeAreaView style={s.center}>
          <Text style={s.h2}>Calls need the full app build</Text>
          <Text style={[s.mute, { marginVertical: 12 }]}>Live calls don’t run in Expo Go or Snack. Install the development build to try them.</Text>
          <Btn label="Close" onPress={() => onEnd(false)} />
        </SafeAreaView>
      </Modal>
    );
  }
  return (
    <Modal visible animationType="slide" onRequestClose={() => {}}>
      <CallRecordingGuard remoteAllowsRecording={otherAllowsRecording} />
      <LiveCall call={call} url={url} token={token} otherName={otherName} e2eeKey={e2eeKey} safety={safety} onEnd={onEnd} />
    </Modal>
  );
}

function IncomingCall({ call, name, onAccept, onDecline }) {
  const { t, s } = useStyles();
  return (
    <Modal visible animationType="fade" onRequestClose={onDecline}>
      <SafeAreaView style={[s.center, { alignItems: 'center', backgroundColor: '#0f1020' }]}>
        <Avatar name={name} size={120} round />
        <Text style={{ color: '#fff', fontSize: 28, fontWeight: '700', marginTop: 20 }}>{name}</Text>
        <Text style={{ color: '#dfe1ff', marginTop: 6 }}>Incoming {call.kind} call</Text>
        <View style={{ flexDirection: 'row', gap: 60, marginTop: 70 }}>
          <Pressable onPress={onDecline} accessibilityRole="button" accessibilityLabel="Decline" style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: '#e5484d', alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 28, color: '#fff' }}>✆</Text></Pressable>
          <Pressable onPress={onAccept} accessibilityRole="button" accessibilityLabel="Accept" style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: '#17a398', alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 28, color: '#fff' }}>✆</Text></Pressable>
        </View>
      </SafeAreaView>
    </Modal>
  );
}

function Calls({ onSettings, onCall, refreshKey }) {
  const { t, s } = useStyles();
  const [log, setLog] = useState([]);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [picking, setPicking] = useState(false);
  const [chats, setChats] = useState([]);
  const load = async () => {
    const { data, error } = await supabase.rpc('my_calls');
    error ? fail(error) : setLog(data || []);
  };
  useEffect(() => { load(); }, [refreshKey]);
  const openPicker = async () => {
    const { data, error } = await supabase.rpc('my_chats');
    if (error) return fail(error);
    setChats((data || []).filter((c) => !c.is_group));
    setPicking(true);
  };
  const soon = (what) => Alert.alert(what, 'This comes in a later build.');
  const clear = () => {
    if (!log.length) return Alert.alert('Nothing to clear', 'Your call log is empty.');
    Alert.alert('Clear call log?', 'This clears the list for you only.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Clear', style: 'destructive', onPress: async () => { const { error } = await supabase.rpc('clear_call_log'); error ? fail(error) : setLog([]); } }]);
  };
  const miss = (c) => !c.outgoing && ['missed', 'cancelled'].includes(c.status);
  const nm = (c) => c.other_name || (c.other_phone ? '+' + c.other_phone : 'Deleted account');
  // The two people you call most often, shown in the quick row.
  const frequent = useMemo(() => {
    const n = {};
    log.forEach((c) => { if (!n[c.other_id]) n[c.other_id] = { c, count: 0 }; n[c.other_id].count++; });
    return Object.values(n).sort((a, b) => b.count - a.count).slice(0, 2).map((x) => x.c);
  }, [log]);
  const shown = log.filter((c) => !q.trim() || nm(c).toLowerCase().includes(q.trim().toLowerCase()));
  const Circle = ({ children, text, onPress }) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={text} style={{ width: 92, alignItems: 'center', gap: 8 }}>
      <View style={{ width: 68, height: 68, borderRadius: 34, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>{children}</View>
      <Text style={[s.mute, { fontSize: 14 }]} numberOfLines={1}>{text}</Text>
    </Pressable>
  );
  return (
    <SafeAreaView style={s.screen}>
      <View style={s.bar}>
        <Text style={[s.h2, { fontSize: 24 }]}>Calls</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Pressable onPress={() => { setSearching(!searching); setQ(''); }} accessibilityRole="button" accessibilityLabel="Search calls" hitSlop={8}><Text style={{ fontSize: 20 }}>🔍</Text></Pressable>
          <HeaderMenu items={[['Clear call log', clear], ['Settings', onSettings]]} />
        </View>
      </View>
      {searching ? <View style={s.row}><TextInput style={[s.input, { flex: 1, marginVertical: 0, borderWidth: 0, borderRadius: 26, paddingHorizontal: 18 }]} value={q} onChangeText={setQ} placeholder="Search calls" accessibilityLabel="Search calls" autoFocus /></View> : null}
      <ScrollView>
        {!searching ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ paddingVertical: 14, paddingHorizontal: 4, gap: 4 }}>
            <Circle text="Call" onPress={openPicker}><Text style={{ fontSize: 26, color: t.ink }}>✆</Text></Circle>
            <Circle text="Schedule" onPress={() => soon('Schedule')}><Text style={{ fontSize: 26, color: t.ink }}>🗓</Text></Circle>
            <Circle text="Keypad" onPress={() => soon('Keypad')}><Text style={{ fontSize: 26, color: t.ink }}>⌗</Text></Circle>
            {frequent.map((c) => <Circle key={c.other_id} text={nm(c)} onPress={() => onCall(c.conversation_id, 'voice')}><Avatar name={nm(c)} size={68} round /></Circle>)}
            <Circle text="Favourites" onPress={() => soon('Favourites')}><Text style={{ fontSize: 26, color: t.ink }}>♡</Text></Circle>
          </ScrollView>
        ) : null}
        <Text style={[s.h2, { paddingHorizontal: 16, paddingVertical: 8 }]}>Recent</Text>
        {shown.length ? shown.map((c) => (
          <Pressable key={c.id} onPress={() => onCall(c.conversation_id, c.kind)} accessibilityRole="button" accessibilityLabel={`Call ${nm(c)} again`} style={s.chatRow}>
            <Avatar name={nm(c)} round />
            <View style={{ flex: 1 }}>
              <Text style={[s.name, miss(c) && { color: '#e5484d' }]}>{nm(c)}</Text>
              <Text style={s.mute}>{c.outgoing ? '↗' : '↙'} {c.status === 'declined' ? 'Declined · ' : ''}{listTime(c.started_at)}</Text>
            </View>
            <Text style={{ fontSize: 22, color: t.ink }}>{c.kind === 'video' ? '🎥' : '✆'}</Text>
          </Pressable>
        )) : <Text style={[s.mute, { padding: 24, textAlign: 'center' }]}>{q ? 'No matching calls.' : 'No calls yet. Tap the call button to start one.'}</Text>}
        <View style={{ height: 90 }} />
      </ScrollView>
      <Pressable onPress={openPicker} accessibilityRole="button" accessibilityLabel="New call" style={{ position: 'absolute', right: 18, bottom: 18, width: 64, height: 64, borderRadius: 20, backgroundColor: t.surf, borderWidth: 1, borderColor: t.line, alignItems: 'center', justifyContent: 'center', elevation: 6, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 10 }}>
        <Text style={{ fontSize: 24, color: t.ink }}>✆＋</Text>
      </Pressable>
      <Modal visible={picking} animationType="slide" onRequestClose={() => setPicking(false)}>
        <SafeAreaView style={s.screen}>
          <View style={s.bar}><Pressable onPress={() => setPicking(false)}><Text style={s.link}>Close</Text></Pressable><Text style={s.h2}>New call</Text><View style={{ width: 50 }} /></View>
          <FlatList data={chats} keyExtractor={(c) => c.conversation_id}
            ListEmptyComponent={<Text style={[s.mute, { padding: 24, textAlign: 'center' }]}>No chats yet. Start a chat first, then you can call that person.</Text>}
            renderItem={({ item }) => (
              <View style={s.chatRow}>
                <Avatar name={label(item)} round />
                <Text style={[s.name, { flex: 1 }]}>{label(item)}</Text>
                <Pressable onPress={() => { setPicking(false); onCall(item.conversation_id, 'voice'); }} accessibilityLabel={`Voice call ${label(item)}`} hitSlop={8}><Text style={{ fontSize: 22, color: t.acc }}>✆</Text></Pressable>
                <Pressable onPress={() => { setPicking(false); onCall(item.conversation_id, 'video'); }} accessibilityLabel={`Video call ${label(item)}`} hitSlop={8} style={{ marginLeft: 16 }}><Text style={{ fontSize: 22, color: t.acc }}>🎥</Text></Pressable>
              </View>
            )} />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function RestoreKeys({ blob, onDone, onFresh }) {
  const { s } = useStyles();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const ok = await restoreBackup(blob, pass);
      if (!ok) { setBusy(false); return Alert.alert('Wrong passphrase', 'That passphrase didn’t unlock your backup. Try again.'); }
      onDone();
    } catch (e) { setBusy(false); fail(e); }
  };
  const fresh = () => Alert.alert('Start without your old messages?', 'Messages sent to you before now will show as “can’t be unlocked”, and they can’t be recovered later. Your encrypted backup stays on file until you replace it.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Start fresh', style: 'destructive', onPress: onFresh }]);
  return (
    <SafeAreaView style={s.center}>
      <Text style={s.h1}>Restore your messages</Text>
      <Text style={s.mute}>This phone has no encryption key yet, but you have an encrypted backup. Enter your backup passphrase to read your old messages here.</Text>
      <TextInput style={s.input} value={pass} onChangeText={setPass} placeholder="Backup passphrase" secureTextEntry autoCapitalize="none" accessibilityLabel="Backup passphrase" />
      <Btn label={busy ? 'Unlocking…' : 'Restore'} onPress={busy || pass.length < 8 ? () => {} : go} />
      <Btn label="Start without my old messages" onPress={fresh} quiet />
    </SafeAreaView>
  );
}

function BackupSheet({ onClose }) {
  const { s } = useStyles();
  const [has, setHas] = useState(null);
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { supabase.from('key_backups').select('user_id').maybeSingle().then(({ data }) => setHas(!!data)); }, []);
  const save = async () => {
    if (pass.length < 8) return Alert.alert('Too short', 'Use at least 8 characters. A longer phrase of several words is stronger.');
    if (pass !== again) return Alert.alert('Doesn’t match', 'The two passphrases are different.');
    setBusy(true);
    try { await makeBackup(pass); setHas(true); setPass(''); setAgain(''); Alert.alert('Backup saved', 'On a new phone, sign in and enter this passphrase to read your old messages. If you forget it, nobody can recover them, including us.'); }
    catch (e) { fail(e); } finally { setBusy(false); }
  };
  const turnOff = () => Alert.alert('Turn off backup?', 'If you lose this phone, your old messages can’t be recovered.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Turn off', style: 'destructive', onPress: async () => { const { error } = await supabase.from('key_backups').delete().eq('user_id', (await supabase.auth.getUser()).data.user.id); error ? fail(error) : setHas(false); } }]);
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.screen}>
        <View style={s.bar}><Pressable onPress={onClose}><Text style={s.link}>Close</Text></Pressable><Text style={s.h2}>Encrypted backup</Text><View style={{ width: 50 }} /></View>
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Text style={s.mute}>Your messages are locked with a key that lives only on this phone. A backup lets you read them on a new phone. The backup is locked with a passphrase that only you know; we can’t read it or reset it.</Text>
          <Text style={[s.name, { marginTop: 16 }]}>{has === null ? 'Checking…' : has ? 'Backup is on' : 'Backup is off'}</Text>
          <TextInput style={s.input} value={pass} onChangeText={setPass} placeholder={has ? 'New passphrase' : 'Choose a passphrase'} secureTextEntry autoCapitalize="none" accessibilityLabel="Passphrase" />
          <TextInput style={s.input} value={again} onChangeText={setAgain} placeholder="Type it again" secureTextEntry autoCapitalize="none" accessibilityLabel="Passphrase again" />
          <Btn label={busy ? 'Saving…' : has ? 'Change passphrase' : 'Turn on backup'} onPress={busy ? () => {} : save} />
          {has ? <Btn label="Turn off backup" onPress={turnOff} quiet /> : null}
          <Text style={[s.mute, { marginTop: 16 }]}>Write the passphrase down somewhere safe. If you forget it, your old messages can’t be recovered.</Text>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function AccountScreen({ profile, onClose }) {
  const { t, s } = useStyles();
  const later = () => Alert.alert('Coming later', 'Chat Up signs in with SMS codes, so this isn’t available yet.');
  const Group = ({ title, rows }) => (
    <View style={{ borderBottomWidth: 1, borderColor: t.line, paddingVertical: 6 }}>
      {title ? <Text style={[s.mute, { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6, fontWeight: '600' }]}>{title}</Text> : null}
      {rows.map(([icon, text, fn, red, tag]) => (
        <Pressable key={text} onPress={fn} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 22, padding: 16 }}>
          <Text style={{ width: 26, textAlign: 'center', fontSize: 20, color: red ? '#e5484d' : t.mute }}>{icon}</Text>
          <Text style={{ flex: 1, fontSize: 17, color: red ? '#e5484d' : t.ink }}>{text}</Text>
          {tag ? <Text style={{ fontSize: 12, color: t.mute }}>{tag}</Text> : null}
        </Pressable>
      ))}
    </View>
  );
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={s.screen}>
        <View style={[s.bar, { justifyContent: 'flex-start', gap: 18 }]}>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8}><Text style={{ fontSize: 24, color: t.ink }}>←</Text></Pressable>
          <Text style={[s.h2, { fontSize: 22 }]}>Account</Text>
        </View>
        <ScrollView>
          <Group rows={[['➕', 'Add account', later, false, 'Later']]} />
          <Group title="Login and security" rows={[['🗝', 'Passkeys', later, false, 'Later'], ['***', 'Password', later, false, 'Later'], ['✉', 'Email address', later, false, 'Later'], ['🔐', 'Two-step verification', later, false, 'Later'], ['🛡', 'Security notifications', later, false, 'Later']]} />
          <Group title="Your account" rows={[['@', 'Username', later, false, 'Later'], ['☎', 'Change phone number', later, false, 'Later'], ['📱', 'Phone number: +' + profile.phone, () => Alert.alert('Your number', 'Friends find you by this number.')]]} />
          <Group rows={[['↪', 'Log out', () => supabase.auth.signOut(), true], ['🗑', 'Delete my account', confirmDeleteAccount, true]]} />
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Settings({ profile, onEditName, onProfileChanged, protect, setProtect }) {
  const { t, s } = useStyles();
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showBlocked, setShowBlocked] = useState(false);
  const [allowRec, setAllowRec] = useState(!!profile.allow_recording);
  const scheme = useColorScheme();
  const saveRec = async (v) => {
    setAllowRec(v);
    const { error } = await supabase.from('profiles').update({ allow_recording: v }).eq('id', profile.id);
    if (error) { setAllowRec(!v); return fail(error); }
    onProfileChanged({ ...profile, allow_recording: v });
  };
  const info = (title, body) => () => Alert.alert(title, body);
  const rows = [
    ['🔑', 'Account', 'Log out, delete my account', () => setShowAccount(true)],
    ['🔒', 'Privacy', 'Recording, blocked people', () => setShowPrivacy(true)],
    ['🛟', 'Encrypted backup', 'Read old messages on a new phone', () => setShowBackup(true)],
    ['💬', 'Chats', 'Chat history', info('Chats', 'Chat backup and history options come in a later build.')],
    ['🎨', 'Appearance', scheme === 'dark' ? 'Dark (follows your phone)' : 'Light (follows your phone)', info('Appearance', 'Chat Up follows your phone’s light or dark setting. Change it in your phone’s display settings.')],
    ['🔔', 'Notifications', 'Message and group alerts', info('Notifications', 'Change Chat Up’s sounds and alerts in your phone’s notification settings.')],
    ['◔', 'Storage and data', 'Network usage, auto-download', info('Storage and data', 'Data controls come in a later build.')],
    ['🌐', 'App language', 'English (device’s language)', info('App language', 'Chat Up uses your phone’s language. More translations come later.')],
    ['?', 'Help and feedback', 'Contact us, terms, privacy policy', () => Alert.alert('Help and feedback', 'Questions or problems? We reply by email.', [
      { text: 'Email support', onPress: () => openUrl('mailto:' + SUPPORT_EMAIL) },
      { text: 'Terms of Use', onPress: () => openUrl(TERMS_URL) },
      { text: 'Privacy Policy', onPress: () => openUrl(PRIVACY_URL) },
    ])],
    ['👥', 'Invite a friend', '', info('Invite a friend', 'Invite links are added before launch.')],
  ];
  return (
    <SafeAreaView style={s.screen}>
      <View style={s.bar}><Text style={[s.h2, { fontSize: 24 }]}>Settings</Text><View style={{ width: 40 }} /></View>
      <ScrollView>
        <Pressable onPress={onEditName} accessibilityRole="button" accessibilityLabel="Edit your name" style={[s.chatRow, { paddingVertical: 18 }]}>
          <Avatar name={profile.name} size={60} />
          <View style={{ flex: 1 }}><Text style={[s.name, { fontSize: 20 }]}>{profile.name}</Text><Text style={s.mute}>+{profile.phone} · tap to edit</Text></View>
        </Pressable>
        {rows.map(([icon, title, sub, fn]) => (
          <Pressable key={title} onPress={fn} accessibilityRole="button" style={[s.chatRow, { paddingVertical: 14 }]}>
            <Text style={{ width: 28, textAlign: 'center', fontSize: 20, color: t.mute }}>{icon}</Text>
            <View style={{ flex: 1 }}><Text style={{ fontSize: 17, color: t.ink }}>{title}</Text>{sub ? <Text style={s.mute}>{sub}</Text> : null}</View>
          </Pressable>
        ))}
        <Btn label="Sign out" onPress={() => supabase.auth.signOut()} quiet />
      </ScrollView>
      {showBackup && <BackupSheet onClose={() => setShowBackup(false)} />}
      {showAccount && <AccountScreen profile={profile} onClose={() => setShowAccount(false)} />}
      <Modal visible={showPrivacy} animationType="slide" onRequestClose={() => setShowPrivacy(false)}>
        <SafeAreaView style={s.screen}>
          <View style={s.bar}><Pressable onPress={() => setShowPrivacy(false)}><Text style={s.link}>Close</Text></Pressable><Text style={s.h2}>Privacy</Text><View style={{ width: 50 }} /></View>
          <ScrollView contentContainerStyle={{ padding: 16 }}>
            <View style={s.row}>
              <View style={{ flex: 1 }}><Text style={s.name}>Allow recording of me on calls</Text><Text style={s.mute}>Off by default. When off, people on a call with you can’t screen record your video.</Text></View>
              <Switch value={allowRec} onValueChange={saveRec} accessibilityLabel="Allow recording of me on calls" />
            </View>
            <View style={s.row}>
              <View style={{ flex: 1 }}><Text style={s.name}>Protect my chats</Text><Text style={s.mute}>Blocks screen recording of Chat Up on this phone.</Text></View>
              <Switch value={protect} onValueChange={setProtect} accessibilityLabel="Protect my chats from screen recording" />
            </View>
            <Pressable onPress={() => setShowBlocked(true)} accessibilityRole="button" style={{ padding: 10 }}><Text style={s.name}>Blocked people</Text></Pressable>
            <Text style={[s.mute, { padding: 10 }]}>Screen-recording protection helps, but can’t stop someone photographing a screen with another device.</Text>
          </ScrollView>
          {showBlocked && <BlockedList onClose={() => setShowBlocked(false)} />}
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function TabBar({ tab, setTab }) {
  const { t } = useStyles();
  const items = [['chats', '💬', 'Chats'], ['calls', '✆', 'Calls'], ['updates', '◔', 'Updates'], ['settings', '⚙', 'Settings']];
  return (
    <SafeAreaView style={{ backgroundColor: t.surf, borderTopWidth: 1, borderColor: t.line }}>
      <View style={{ flexDirection: 'row' }}>
        {items.map(([k, icon, label]) => (
          <Pressable key={k} onPress={() => setTab(k)} accessibilityRole="tab" accessibilityState={{ selected: tab === k }} style={{ flex: 1, alignItems: 'center', paddingVertical: 8 }}>
            <View style={{ backgroundColor: tab === k ? t.bg : 'transparent', borderRadius: 16, paddingHorizontal: 20, paddingVertical: 2 }}><Text style={{ fontSize: 20, color: t.ink }}>{icon}</Text></View>
            <Text style={{ fontSize: 12, color: tab === k ? t.acc : t.mute, fontWeight: tab === k ? '700' : '400' }}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  const scheme = useColorScheme();
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(null);
  const [editing, setEditing] = useState(false);
  const [chat, setChat] = useState(null);
  const [tab, setTab] = useState('chats');
  const [protect, setProtectState] = useState(true);
  const [ui, setUi] = useState(null); // { mode: 'incoming' | 'active', call, name, url?, token?, allowsRec? }
  const [callsKey, setCallsKey] = useState(0);
  const uiRef = useRef(null);
  uiRef.current = ui;
  useEffect(() => { AsyncStorage.getItem('chatup.protect').then((v) => { if (v === '0') setProtectState(false); }); }, []);
  const setProtect = (v) => { setProtectState(v); AsyncStorage.setItem('chatup.protect', v ? '1' : '0'); };
  useScreenProtection(!!session && protect);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, sess) => setSession(sess));
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!session) return setProfile(null);
    supabase.from('profiles').select('id, phone, name, allow_recording').eq('id', session.user.id).single().then(({ data, error }) => (error ? fail(error) : setProfile(data)));
  }, [session]);
  const [keyState, setKeyState] = useState('checking'); // checking | restore | ready
  const [backupBlob, setBackupBlob] = useState(null);
  useEffect(() => {
    if (!session) return setKeyState('checking');
    registerPush(session.user.id);
    (async () => {
      try {
        if (await SecureStore.getItemAsync('chatup.nacl.secret')) { publishKey(); return setKeyState('ready'); }
        const { data } = await supabase.from('key_backups').select('blob').maybeSingle();
        if (data?.blob) { setBackupBlob(data.blob); return setKeyState('restore'); }
      } catch (e) { console.log('Backup check failed:', e.message); }
      await publishKey(); setKeyState('ready');
    })();
  }, [session]);
  const otherInfo = async (call, myId) => {
    const oid = call.caller === myId ? call.callee : call.caller;
    const { data } = await supabase.from('profiles').select('name, phone, allow_recording').eq('id', oid).single();
    return { name: data?.name || (data?.phone ? '+' + data.phone : 'Chat Up'), allowsRec: !!data?.allow_recording };
  };
  const showIncoming = async (call) => {
    if (!session || call.callee !== session.user.id || call.status !== 'ringing') return;
    if (Date.now() - new Date(call.started_at).getTime() > 60000) return;
    if (uiRef.current) { supabase.rpc('update_call', { call_id: call.id, new_status: 'declined' }); return; } // already busy
    const o = await otherInfo(call, session.user.id);
    setUi({ mode: 'incoming', call: { ...call, me: session.user.id }, name: o.name, allowsRec: o.allowsRec });
  };
  // Incoming calls and changes to calls I'm in.
  useEffect(() => {
    if (!session) return;
    const id = session.user.id;
    const ch = supabase.channel('calls-' + id)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'calls', filter: `callee=eq.${id}` }, (p) => showIncoming(p.new))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls' }, (p) => {
        const c = p.new, cur = uiRef.current;
        if (c.caller !== id && c.callee !== id) return;
        setCallsKey((k) => k + 1);
        if (!cur || cur.call.id !== c.id) return;
        if (cur.mode === 'incoming' && c.status !== 'ringing') setUi(null); // caller hung up first
        else if (cur.mode === 'active' && c.status === 'declined') { setUi(null); Alert.alert('Call declined', `${cur.name} declined the call.`); }
      }).subscribe();
    const sub = Notifications.addNotificationResponseReceivedListener(async (r) => {
      const d = r.notification.request.content.data;
      if (d?.type !== 'call') return;
      const { data } = await supabase.from('calls').select('*').eq('id', d.call_id).single();
      if (data) showIncoming(data);
    });
    return () => { supabase.removeChannel(ch); sub.remove(); };
  }, [session]);
  const startCall = async (cid, kind) => {
    if (uiRef.current) return;
    try {
      const me = session.user.id;
      const { data: mem, error: e1 } = await supabase.from('conversation_members').select('user_id').eq('conversation_id', cid).neq('user_id', me).single();
      if (e1) throw e1;
      const { data: prof } = await supabase.from('profiles').select('public_key').eq('id', mem.user_id).single();
      if (!prof?.public_key) return Alert.alert('Can’t start an encrypted call', 'This person needs to open the latest version of Chat Up first. Calls are always encrypted.');
      await publishKey();
      const kp = await myKeys();
      const theirPub = decodeBase64(prof.public_key);
      const callKey = nacl.randomBytes(32);
      const r = await callApi({ action: 'start', conversation_id: cid, kind, key_box: lockCallKey(callKey, theirPub, kp.secretKey) });
      const o = await otherInfo(r.call, me);
      setUi({ mode: 'active', call: { ...r.call, me }, name: o.name, allowsRec: o.allowsRec, url: r.url, token: r.token, e2eeKey: encodeBase64(callKey), safety: safetyNumber(kp.publicKey, theirPub) });
    } catch (e) { fail(e); }
  };
  const acceptCall = async () => {
    const cur = uiRef.current;
    try {
      const r = await callApi({ action: 'join', call_id: cur.call.id });
      const { data: prof } = await supabase.from('profiles').select('public_key').eq('id', r.call.caller).single();
      const kp = await myKeys();
      const theirPub = prof?.public_key ? decodeBase64(prof.public_key) : null;
      const callKey = theirPub && r.call.key_box ? openCallKey(r.call.key_box, theirPub, kp.secretKey) : null;
      if (!callKey) throw new Error('Couldn’t unlock this call’s encryption, so it was not connected.');
      setUi({ ...cur, mode: 'active', call: { ...r.call, me: session.user.id }, url: r.url, token: r.token, e2eeKey: encodeBase64(callKey), safety: safetyNumber(kp.publicKey, theirPub) });
    } catch (e) {
      await supabase.rpc('update_call', { call_id: cur.call.id, new_status: 'declined' });
      setUi(null); fail(e);
    }
  };
  const declineCall = async () => {
    const cur = uiRef.current; setUi(null);
    if (cur) await supabase.rpc('update_call', { call_id: cur.call.id, new_status: 'declined' });
    setCallsKey((k) => k + 1);
  };
  const endCall = async (how) => {
    const cur = uiRef.current; if (!cur) return;
    setUi(null);
    const { data } = await supabase.from('calls').select('status').eq('id', cur.call.id).single();
    const st = data?.status;
    if (st === 'ringing') await supabase.rpc('update_call', { call_id: cur.call.id, new_status: cur.call.caller === session.user.id ? (how === 'timeout' ? 'missed' : 'cancelled') : 'declined' });
    else if (st === 'answered') await supabase.rpc('update_call', { call_id: cur.call.id, new_status: 'ended' });
    setCallsKey((k) => k + 1);
  };
  const callLayer = ui ? (ui.mode === 'incoming'
    ? <IncomingCall call={ui.call} name={ui.name} onAccept={acceptCall} onDecline={declineCall} />
    : <CallScreen call={ui.call} url={ui.url} token={ui.token} otherName={ui.name} otherAllowsRecording={ui.allowsRec} e2eeKey={ui.e2eeKey} safety={ui.safety} onEnd={endCall} />) : null;
  const bar = <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />;
  if (session === undefined) return null;
  if (!session) return <>{bar}<Login /></>;
  if (!profile) return null;
  if (keyState === 'checking') return null;
  if (keyState === 'restore') return <>{bar}<RestoreKeys blob={backupBlob} onDone={() => { publishKey(); setKeyState('ready'); }} onFresh={async () => { await publishKey(); setKeyState('ready'); }} /></>;
  if (!profile.name || editing) return <>{bar}<Profile profile={profile} onSaved={(p) => { setProfile(p); setEditing(false); }} onCancel={() => setEditing(false)} protect={protect} setProtect={setProtect} /></>;
  if (chat) return <>{bar}<Chat chat={chat} me={session.user.id} onBack={() => setChat(null)} onCall={startCall} />{callLayer}</>;
  const content = tab === 'chats' ? <Chats profile={profile} onOpen={setChat} onProfile={() => setTab('settings')} />
    : tab === 'calls' ? <Calls onSettings={() => setTab('settings')} onCall={startCall} refreshKey={callsKey} />
    : tab === 'updates' ? <Updates me={session.user.id} profile={profile} />
    : <Settings profile={profile} onEditName={() => setEditing(true)} onProfileChanged={setProfile} protect={protect} setProtect={setProtect} />;
  return <>{bar}<View style={{ flex: 1 }}><View style={{ flex: 1 }}>{content}</View><TabBar tab={tab} setTab={setTab} /></View>{callLayer}</>;
}
