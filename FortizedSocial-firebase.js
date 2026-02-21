const firebaseConfig = {
  apiKey: "AIzaSyDeKw90592XdSKSXr1mefodYhca53AVP9M",
  authDomain: "fortized-5ffcf.firebaseapp.com",
  databaseURL: "https://fortized-5ffcf-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "fortized-5ffcf",
  storageBucket: "fortized-5ffcf.firebasestorage.app",
  messagingSenderId: "232126031951",
  appId: "1:232126031951:web:c66312d3175f137c25223a"
};
// ─────────────────────────────────────────────────────────────

const FortizedSocial = (() => {

  // ── Firebase init ──────────────────────────────────────────
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig); // FIXED: was FIREBASE_CONFIG
  const db = firebase.database();

  // ── DB path helpers ────────────────────────────────────────
  const P = {
    user:        u  => `users/${u}`,
    status:      u  => `statuses/${u}`,
    notifs:      u  => `notifications/${u}`,
    dm:         (a, b) => `dms/${[a, b].sort().join('__')}`,
    dmIndex:     u  => `dmIndex/${u}`,
    bastionMsgs:(id, ch) => `bastionMsgs/${id}/${ch}`,
    bastionMembers: id  => `bastionMembers/${id}`,
    globalBastions:     `globalBastions`,
    globalBastion: id   => `globalBastions/${id}`,
    invites:            `invites`,
    invite:      code   => `invites/${code}`,
  };

  // ── Tiny promise wrappers ──────────────────────────────────
  function dbGet(path) {
    return db.ref(path).get().then(snap => snap.exists() ? snap.val() : null);
  }
  function dbSet(path, val) {
    return db.ref(path).set(val);
  }
  function dbUpdate(path, val) {
    return db.ref(path).update(val);
  }
  function dbPush(path, val) {
    return db.ref(path).push(val);
  }
  function dbRemove(path) {
    return db.ref(path).remove();
  }
  function dbTransaction(path, fn) {
    return db.ref(path).transaction(fn);
  }

  // ── Session ────────────────────────────────────────────────
  function getCurrentUsername() {
    return localStorage.getItem('ftz_current') ||
           localStorage.getItem('fortized_current_user') || null;
  }
  function setCurrentUsername(u) {
    localStorage.setItem('ftz_current', u);
    localStorage.setItem('fortized_current_user', u);
  }
  function clearCurrentUsername() {
    localStorage.removeItem('ftz_current');
    localStorage.removeItem('fortized_current_user');
  }

  // ── User CRUD ──────────────────────────────────────────────
  async function getUsers() {
    const snap = await db.ref('users').get();
    if (!snap.exists()) return [];
    return Object.values(snap.val());
  }

  async function getUserByName(username) {
    if (!username) return null;
    return dbGet(P.user(username));
  }

  async function saveUserObject(user) {
    if (!user?.username) return;
    await dbUpdate(P.user(user.username), user);
  }

  // ── Auth ───────────────────────────────────────────────────
  async function register(username, password, email = '') {
    username = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!username || username.length < 3)
      return { ok: false, msg: 'Username must be 3+ characters (a-z, 0-9, _).' };
    if (!password || password.length < 6)
      return { ok: false, msg: 'Password must be 6+ characters.' };

    const existing = await getUserByName(username);
    if (existing) return { ok: false, msg: 'Username already taken.' };

    const user = {
      username, password, email,
      displayName: username,
      pfp: null, banner: null,
      onyx: 25,
      status: 'online',
      friends: [],
      friendRequestsSent: [],
      friendRequestsReceived: [],
      bastions: [],
      notifications: [],
      radianceUntil: null,
      lastDaily: null,
      createdAt: new Date().toISOString()
    };
    await dbSet(P.user(username), user);
    setCurrentUsername(username); // FIXED: also set session on register
    return { ok: true, user };
  }

  async function login(username, password) {
    username = username.trim().toLowerCase();
    const user = await getUserByName(username);
    if (!user) return { ok: false, msg: 'User not found.' };
    if (user.password !== password) return { ok: false, msg: 'Wrong password.' };
    setCurrentUsername(username);
    await setStatus(username, 'online');
    return { ok: true, user };
  }

  async function logout(username) {
    await setStatus(username, 'offline');
    stopPolling();
    clearCurrentUsername();
  }

  // ── Status ─────────────────────────────────────────────────
  async function getStatus(username) {
    const val = await dbGet(P.status(username));
    return val || 'offline';
  }

  async function setStatus(username, status) {
    await dbSet(P.status(username), status);
    await dbUpdate(P.user(username), { status });
  }

  // ── Notifications ──────────────────────────────────────────
  async function getNotifications(username) {
    const data = await dbGet(P.notifs(username));
    if (!data) return [];
    return Object.values(data).sort((a, b) =>
      new Date(b.time) - new Date(a.time)
    );
  }

  async function addNotification(toUsername, notif) {
    notif.id   = Date.now().toString(36) + Math.random().toString(36).slice(2);
    notif.time = new Date().toISOString();
    notif.read = false;
    await dbSet(`${P.notifs(toUsername)}/${notif.id}`, notif);
  }

  async function markNotificationsRead(username) {
    const data = await dbGet(P.notifs(username));
    if (!data) return;
    const updates = {};
    Object.keys(data).forEach(k => { updates[`${k}/read`] = true; });
    await dbUpdate(P.notifs(username), updates);
  }

  async function getUnreadCount(username) {
    const notifs = await getNotifications(username);
    return notifs.filter(n => !n.read).length;
  }

  // ── Friend System ──────────────────────────────────────────
  async function sendFriendRequest(fromUsername, toUsername) {
    if (fromUsername === toUsername) return { ok: false, msg: "Can't add yourself." };

    const [fu, tu] = await Promise.all([
      getUserByName(fromUsername),
      getUserByName(toUsername)
    ]);
    if (!fu) return { ok: false, msg: 'Your account not found.' };
    if (!tu) return { ok: false, msg: 'User not found.' };

    const friends       = fu.friends           || [];
    const sentReqs      = fu.friendRequestsSent || [];
    const theirSentReqs = tu.friendRequestsSent || [];

    if (friends.includes(toUsername))    return { ok: false, msg: 'Already friends.' };
    if (sentReqs.includes(toUsername))   return { ok: false, msg: 'Request already sent.' };

    if (theirSentReqs.includes(fromUsername)) {
      return acceptFriendRequest(fromUsername, toUsername);
    }

    await dbUpdate(P.user(fromUsername), {
      friendRequestsSent: [...sentReqs, toUsername]
    });
    const theirReceived = tu.friendRequestsReceived || [];
    if (!theirReceived.includes(fromUsername)) {
      await dbUpdate(P.user(toUsername), {
        friendRequestsReceived: [...theirReceived, fromUsername]
      });
    }

    await addNotification(toUsername, { type: 'friend_request', from: fromUsername });
    return { ok: true, msg: `Friend request sent to ${toUsername}!` };
  }

  async function acceptFriendRequest(myUsername, fromUsername) {
    const [mu, fu] = await Promise.all([
      getUserByName(myUsername),
      getUserByName(fromUsername)
    ]);
    if (!mu || !fu) return { ok: false, msg: 'User not found.' };

    const myFriends  = [...(mu.friends || [])];
    const hisFriends = [...(fu.friends || [])];
    if (!myFriends.includes(fromUsername))  myFriends.push(fromUsername);
    if (!hisFriends.includes(myUsername))   hisFriends.push(myUsername);

    await dbUpdate(P.user(myUsername), {
      friends:                myFriends,
      friendRequestsReceived: (mu.friendRequestsReceived || []).filter(u => u !== fromUsername),
      friendRequestsSent:     (mu.friendRequestsSent     || []).filter(u => u !== fromUsername)
    });
    await dbUpdate(P.user(fromUsername), {
      friends:                hisFriends,
      friendRequestsSent:     (fu.friendRequestsSent     || []).filter(u => u !== myUsername),
      friendRequestsReceived: (fu.friendRequestsReceived || []).filter(u => u !== myUsername)
    });

    await addNotification(fromUsername, { type: 'friend_accept', from: myUsername });
    return { ok: true, msg: `You are now friends with ${fromUsername}!` };
  }

  const acceptFriend = acceptFriendRequest;

  async function declineFriendRequest(myUsername, fromUsername) {
    const [mu, fu] = await Promise.all([
      getUserByName(myUsername),
      getUserByName(fromUsername)
    ]);
    if (mu) await dbUpdate(P.user(myUsername), {
      friendRequestsReceived: (mu.friendRequestsReceived || []).filter(u => u !== fromUsername)
    });
    if (fu) await dbUpdate(P.user(fromUsername), {
      friendRequestsSent: (fu.friendRequestsSent || []).filter(u => u !== myUsername)
    });
    return { ok: true };
  }

  async function removeFriend(myUsername, friendUsername) {
    const [mu, fu] = await Promise.all([
      getUserByName(myUsername),
      getUserByName(friendUsername)
    ]);
    if (mu) await dbUpdate(P.user(myUsername), {
      friends: (mu.friends || []).filter(u => u !== friendUsername)
    });
    if (fu) await dbUpdate(P.user(friendUsername), {
      friends: (fu.friends || []).filter(u => u !== myUsername)
    });
    return { ok: true };
  }

  // ── Direct Messages ────────────────────────────────────────
  async function getDMMessages(user1, user2) {
    const data = await dbGet(P.dm(user1, user2));
    if (!data) return [];
    return Object.values(data).sort((a, b) =>
      new Date(a.timestamp) - new Date(b.timestamp)
    );
  }

  async function sendDMMessage(fromUsername, toUsername, text) {
    const now = new Date();
    const msg = {
      id:        Date.now().toString(36) + Math.random().toString(36).slice(2),
      from:      fromUsername,
      text,
      time:      now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: now.toISOString()
    };

    await dbSet(`${P.dm(fromUsername, toUsername)}/${msg.id}`, msg);

    const [myIdx, theirIdx] = await Promise.all([
      dbGet(P.dmIndex(fromUsername)),
      dbGet(P.dmIndex(toUsername))
    ]);

    const updateIdx = async (username, partner, current) => {
      const arr = current ? (Array.isArray(current) ? current : Object.values(current)) : [];
      const filtered = arr.filter(u => u !== partner);
      filtered.unshift(partner);
      await dbSet(P.dmIndex(username), filtered.slice(0, 30));
    };
    await Promise.all([
      updateIdx(fromUsername, toUsername, myIdx),
      updateIdx(toUsername, fromUsername, theirIdx)
    ]);

    await addNotification(toUsername, {
      type: 'dm', from: fromUsername,
      data: { preview: text.slice(0, 60) }
    });

    return msg;
  }

  async function getRecentDMPartners(username) {
    const data = await dbGet(P.dmIndex(username));
    if (!data) return [];
    return Array.isArray(data) ? data : Object.values(data);
  }

  // ── Bastion Messages ───────────────────────────────────────
  async function getBastionChannelMessages(bastionId, channelId) {
    const data = await dbGet(P.bastionMsgs(bastionId, channelId));
    if (!data) return [];
    return Object.values(data).sort((a, b) =>
      new Date(a.timestamp) - new Date(b.timestamp)
    );
  }

  async function sendBastionChannelMessage(bastionId, channelId, fromUsername, text) {
    const now = new Date();
    const msgRef = db.ref(P.bastionMsgs(bastionId, channelId)).push();
    const msg = {
      id:        msgRef.key,
      from:      fromUsername,
      text,
      time:      now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: now.toISOString()
    };
    await msgRef.set(msg);
    return msg;
  }

  async function addReaction(bastionId, channelId, msgId, emoji, username) {
    const path = `${P.bastionMsgs(bastionId, channelId)}/${msgId}/reactions/${emoji}`;
    await dbTransaction(path, current => {
      const arr = current ? (Array.isArray(current) ? current : Object.values(current)) : [];
      const idx = arr.indexOf(username);
      if (idx !== -1) arr.splice(idx, 1);
      else arr.push(username);
      return arr.length ? arr : null;
    });
  }

  // ── Global Bastions ────────────────────────────────────────
  async function getGlobalBastions() {
    return (await dbGet(P.globalBastions)) || {};
  }

  async function saveGlobalBastion(id, data) {
    await dbSet(P.globalBastion(id), data);
  }

  async function getGlobalBastion(id) {
    return dbGet(P.globalBastion(id));
  }

  // ── Bastion Members ────────────────────────────────────────
  async function getBastionMembers(bastionId) {
    const data = await dbGet(P.bastionMembers(bastionId));
    if (!data) return [];
    return Array.isArray(data) ? data : Object.values(data);
  }

  async function addBastionMember(bastionId, username) {
    const members = await getBastionMembers(bastionId);
    if (!members.includes(username)) members.push(username);
    await dbSet(P.bastionMembers(bastionId), members);
  }

  async function removeBastionMember(bastionId, username) {
    const members = await getBastionMembers(bastionId);
    await dbSet(P.bastionMembers(bastionId), members.filter(u => u !== username));
  }

  // ── Invites ────────────────────────────────────────────────
  async function getInvite(code) {
    return dbGet(P.invite(code));
  }

  async function saveInvite(code, data) {
    await dbSet(P.invite(code), data);
  }

  async function incrementInviteUses(code) {
    await dbTransaction(P.invite(code) + '/uses', n => (n || 0) + 1);
  }

  // ── Real-time Listeners ────────────────────────────────────
  let _listeners = [];
  let _callbacks = {};

  function startPolling(username, callbacks = {}) {
    _callbacks = callbacks;
    stopPolling();

    const notifRef = db.ref(P.notifs(username));
    const notifHandler = notifRef.on('child_added', snap => {
      const n = snap.val();
      if (!n || n.read) return;
      _callbacks.onNewNotification?.(n);
      updateNotifBadgeExternal(username);
    });
    _listeners.push({ ref: notifRef, event: 'child_added', handler: notifHandler });

    const dmIndexRef = db.ref(P.dmIndex(username));
    const dmIndexHandler = dmIndexRef.on('value', snap => {
      _callbacks.onDMIndexChange?.();
    });
    _listeners.push({ ref: dmIndexRef, event: 'value', handler: dmIndexHandler });

    const statusRef = db.ref('statuses');
    const statusHandler = statusRef.on('child_changed', snap => {
      _callbacks.onStatusChange?.({ username: snap.key, status: snap.val() });
    });
    _listeners.push({ ref: statusRef, event: 'child_changed', handler: statusHandler });
  }

  function stopPolling() {
    _listeners.forEach(({ ref, event, handler }) => {
      try { ref.off(event, handler); } catch (_) {}
    });
    _listeners = [];
  }

  function listenBastionChannel(bastionId, channelId, callback) {
    const ref = db.ref(P.bastionMsgs(bastionId, channelId));
    const handler = ref.on('child_added', snap => {
      callback?.(snap.val());
    });
    return () => ref.off('child_added', handler);
  }

  function listenDM(user1, user2, callback) {
    const ref = db.ref(P.dm(user1, user2));
    const handler = ref.on('child_added', snap => {
      callback?.(snap.val());
    });
    return () => ref.off('child_added', handler);
  }

  async function updateNotifBadgeExternal(username) {
    if (typeof window !== 'undefined' && typeof window.updateNotifBadge === 'function') {
      window.updateNotifBadge();
    }
  }

  // ── Audio ──────────────────────────────────────────────────
  function playNotificationSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1100, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch (_) {}
  }

  // ── Public API ─────────────────────────────────────────────
  return {
    register, login, logout, getCurrentUsername,
    getUsers, getUserByName, saveUserObject,
    getStatus, setStatus,
    getNotifications, addNotification, markNotificationsRead, getUnreadCount,
    sendFriendRequest, acceptFriendRequest, acceptFriend, declineFriendRequest, removeFriend,
    getDMMessages, sendDMMessage, getRecentDMPartners,
    getBastionChannelMessages, sendBastionChannelMessage, addReaction,
    getGlobalBastions, saveGlobalBastion, getGlobalBastion,
    getBastionMembers, addBastionMember, removeBastionMember,
    getInvite, saveInvite, incrementInviteUses,
    startPolling, stopPolling, listenBastionChannel, listenDM,
    playNotificationSound,
  };

})();
