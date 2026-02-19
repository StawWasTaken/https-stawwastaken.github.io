/**
 * FortizedSocial — Self-contained social backend
 * Uses localStorage as the database, BroadcastChannel for real-time cross-tab sync.
 * No server required. All data is scoped per-user.
 */
const FortizedSocial = (() => {

  // ─── KEYS ────────────────────────────────────────────────────────────
  const KEY_USERS      = 'ftz_users';
  const KEY_STATUSES   = 'ftz_statuses';
  const KEY_DMS        = 'ftz_dms';
  const KEY_BAST_MSGS  = 'ftz_bmsgs';
  const notifKey   = u => `ftz_notifs_${u}`;
  const dmKey      = (a, b) => `ftz_dm_${[a,b].sort().join('__')}`;

  // ─── BROADCAST CHANNEL ────────────────────────────────────────────────
  let bc = null;
  try { bc = new BroadcastChannel('fortized'); } catch(e) {}

  function broadcast(type, data) {
    try { bc?.postMessage({ type, data, ts: Date.now() }); } catch(e) {}
  }

  // ─── STORAGE HELPERS ─────────────────────────────────────────────────
  function get(key, fallback = null) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch(e) { return fallback; }
  }
  function set(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch(e) {}
  }

  // ─── USER CRUD ────────────────────────────────────────────────────────
  function getUsers() { return get(KEY_USERS, []); }
  function saveUsers(users) { set(KEY_USERS, users); }

  function getUserByName(username) {
    return getUsers().find(u => u.username === username) || null;
  }

  function saveUserObject(user) {
    const users = getUsers();
    const idx = users.findIndex(u => u.username === user.username);
    if (idx !== -1) users[idx] = { ...users[idx], ...user };
    else users.push(user);
    saveUsers(users);
  }

  // Ensure user fields are initialized
  function initUser(username) {
    const users = getUsers();
    const idx = users.findIndex(u => u.username === username);
    if (idx === -1) return;
    const u = users[idx];
    if (!Array.isArray(u.friends)) u.friends = [];
    if (!Array.isArray(u.friendRequestsSent)) u.friendRequestsSent = [];
    if (!Array.isArray(u.friendRequestsReceived)) u.friendRequestsReceived = [];
    if (!Array.isArray(u.bastions)) u.bastions = [];
    if (!Array.isArray(u.notifications)) u.notifications = [];
    if (typeof u.onyx !== 'number') u.onyx = 5;
    if (!u.status) u.status = 'online';
    if (!u.displayName) u.displayName = u.username;
    users[idx] = u;
    saveUsers(users);
    return users[idx];
  }

  // ─── AUTH ─────────────────────────────────────────────────────────────
  function register(username, password, email = '') {
    username = username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!username || username.length < 3) return { ok: false, msg: 'Username must be 3+ characters (a-z, 0-9, _).' };
    if (!password || password.length < 6) return { ok: false, msg: 'Password must be 6+ characters.' };
    const users = getUsers();
    if (users.find(u => u.username === username)) return { ok: false, msg: 'Username already taken.' };
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
    users.push(user);
    saveUsers(users);
    return { ok: true, user };
  }

  function login(username, password) {
    username = username.trim().toLowerCase();
    const user = getUserByName(username);
    if (!user) return { ok: false, msg: 'User not found.' };
    if (user.password !== password) return { ok: false, msg: 'Wrong password.' };
    localStorage.setItem('ftz_current', username);
    setStatus(username, 'online');
    return { ok: true, user };
  }

  function logout(username) {
    setStatus(username, 'offline');
    stopPolling();
    localStorage.removeItem('ftz_current');
  }

  function getCurrentUsername() {
    return localStorage.getItem('ftz_current') || localStorage.getItem('fortized_current_user') || null;
  }

  // ─── STATUS ───────────────────────────────────────────────────────────
  function getStatus(username) {
    const statuses = get(KEY_STATUSES, {});
    return statuses[username] || 'offline';
  }
  function setStatus(username, status) {
    const statuses = get(KEY_STATUSES, {});
    statuses[username] = status;
    set(KEY_STATUSES, statuses);
    broadcast('status', { username, status });
  }

  // ─── NOTIFICATIONS ────────────────────────────────────────────────────
  function getNotifications(username) {
    // Read directly from user object (single source of truth)
    const user = getUserByName(username);
    return (user?.notifications || []).slice().reverse(); // newest first
  }

  function addNotification(toUsername, notif) {
    const users = getUsers();
    const idx = users.findIndex(u => u.username === toUsername);
    if (idx === -1) return;
    if (!Array.isArray(users[idx].notifications)) users[idx].notifications = [];
    notif.id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    notif.time = new Date().toISOString();
    notif.read = false;
    users[idx].notifications.unshift(notif);
    // Cap at 50
    if (users[idx].notifications.length > 50) users[idx].notifications = users[idx].notifications.slice(0, 50);
    saveUsers(users);
    broadcast('notification', { to: toUsername, notif });
  }

  function markNotificationsRead(username) {
    const users = getUsers();
    const idx = users.findIndex(u => u.username === username);
    if (idx === -1) return;
    (users[idx].notifications || []).forEach(n => n.read = true);
    saveUsers(users);
  }

  function getUnreadCount(username) {
    return getNotifications(username).filter(n => !n.read).length;
  }

  // ─── FRIEND SYSTEM ────────────────────────────────────────────────────
  function sendFriendRequest(fromUsername, toUsername) {
    if (fromUsername === toUsername) return { ok: false, msg: "Can't add yourself." };
    const users = getUsers();
    const fi = users.findIndex(u => u.username === fromUsername);
    const ti = users.findIndex(u => u.username === toUsername);
    if (fi === -1) return { ok: false, msg: 'Your account not found.' };
    if (ti === -1) return { ok: false, msg: 'User not found.' };

    const fu = users[fi], tu = users[ti];
    if (!Array.isArray(fu.friends)) fu.friends = [];
    if (!Array.isArray(tu.friends)) tu.friends = [];
    if (!Array.isArray(fu.friendRequestsSent)) fu.friendRequestsSent = [];
    if (!Array.isArray(tu.friendRequestsReceived)) tu.friendRequestsReceived = [];

    if (fu.friends.includes(toUsername)) return { ok: false, msg: 'Already friends.' };
    if (fu.friendRequestsSent.includes(toUsername)) return { ok: false, msg: 'Request already sent.' };

    // If they already sent us a request, auto-accept
    if ((tu.friendRequestsSent || []).includes(fromUsername)) {
      return acceptFriendRequest(fromUsername, toUsername);
    }

    fu.friendRequestsSent.push(toUsername);
    if (!tu.friendRequestsReceived.includes(fromUsername)) tu.friendRequestsReceived.push(fromUsername);

    saveUsers(users);

    // Notify recipient
    addNotification(toUsername, { type: 'friend_request', from: fromUsername });
    broadcast('friend_request', { from: fromUsername, to: toUsername });

    return { ok: true, msg: `Friend request sent to ${toUsername}!` };
  }

  function acceptFriendRequest(myUsername, fromUsername) {
    const users = getUsers();
    const mi = users.findIndex(u => u.username === myUsername);
    const fi = users.findIndex(u => u.username === fromUsername);
    if (mi === -1 || fi === -1) return { ok: false, msg: 'User not found.' };

    const mu = users[mi], fu = users[fi];

    // Ensure arrays
    ['friends','friendRequestsSent','friendRequestsReceived'].forEach(k => {
      if (!Array.isArray(mu[k])) mu[k] = [];
      if (!Array.isArray(fu[k])) fu[k] = [];
    });

    // Add to friends both ways
    if (!mu.friends.includes(fromUsername)) mu.friends.push(fromUsername);
    if (!fu.friends.includes(myUsername)) fu.friends.push(myUsername);

    // Remove pending requests
    mu.friendRequestsReceived = mu.friendRequestsReceived.filter(u => u !== fromUsername);
    mu.friendRequestsSent = mu.friendRequestsSent.filter(u => u !== fromUsername);
    fu.friendRequestsSent = fu.friendRequestsSent.filter(u => u !== myUsername);
    fu.friendRequestsReceived = fu.friendRequestsReceived.filter(u => u !== myUsername);

    // Mark old friend_request notifications as read for myUsername
    (mu.notifications || []).forEach(n => {
      if (n.type === 'friend_request' && n.from === fromUsername) n.read = true;
    });

    saveUsers(users);

    // Notify the sender that request was accepted
    addNotification(fromUsername, { type: 'friend_accept', from: myUsername });
    broadcast('friend_accept', { from: myUsername, to: fromUsername });

    return { ok: true, msg: `You are now friends with ${fromUsername}!` };
  }

  function declineFriendRequest(myUsername, fromUsername) {
    const users = getUsers();
    const mi = users.findIndex(u => u.username === myUsername);
    const fi = users.findIndex(u => u.username === fromUsername);
    if (mi !== -1) {
      if (!Array.isArray(users[mi].friendRequestsReceived)) users[mi].friendRequestsReceived = [];
      users[mi].friendRequestsReceived = users[mi].friendRequestsReceived.filter(u => u !== fromUsername);
    }
    if (fi !== -1) {
      if (!Array.isArray(users[fi].friendRequestsSent)) users[fi].friendRequestsSent = [];
      users[fi].friendRequestsSent = users[fi].friendRequestsSent.filter(u => u !== myUsername);
    }
    saveUsers(users);
    return { ok: true };
  }

  function removeFriend(myUsername, friendUsername) {
    const users = getUsers();
    const mi = users.findIndex(u => u.username === myUsername);
    const fi = users.findIndex(u => u.username === friendUsername);
    if (mi !== -1) {
      if (!Array.isArray(users[mi].friends)) users[mi].friends = [];
      users[mi].friends = users[mi].friends.filter(u => u !== friendUsername);
    }
    if (fi !== -1) {
      if (!Array.isArray(users[fi].friends)) users[fi].friends = [];
      users[fi].friends = users[fi].friends.filter(u => u !== myUsername);
    }
    saveUsers(users);
    return { ok: true };
  }

  // ─── DIRECT MESSAGES ─────────────────────────────────────────────────
  function getDMMessages(user1, user2) {
    return get(dmKey(user1, user2), []);
  }

  function sendDMMessage(fromUsername, toUsername, text) {
    const key = dmKey(fromUsername, toUsername);
    const msgs = get(key, []);
    const now = new Date();
    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      from: fromUsername,
      text,
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: now.toISOString()
    };
    msgs.push(msg);
    set(key, msgs);

    // Track DM partners in a global index
    const dmsIndex = get(KEY_DMS, {});
    if (!dmsIndex[fromUsername]) dmsIndex[fromUsername] = [];
    if (!dmsIndex[toUsername]) dmsIndex[toUsername] = [];
    if (!dmsIndex[fromUsername].includes(toUsername)) dmsIndex[fromUsername].unshift(toUsername);
    if (!dmsIndex[toUsername].includes(fromUsername)) dmsIndex[toUsername].unshift(fromUsername);
    // Keep only 30 recent partners
    dmsIndex[fromUsername] = dmsIndex[fromUsername].slice(0, 30);
    dmsIndex[toUsername] = dmsIndex[toUsername].slice(0, 30);
    set(KEY_DMS, dmsIndex);

    // Notify recipient
    addNotification(toUsername, { type: 'dm', from: fromUsername, data: { preview: text.slice(0, 60) } });
    broadcast('dm', { from: fromUsername, to: toUsername, msgId: msg.id });

    return msg;
  }

  function getRecentDMPartners(username) {
    const idx = get(KEY_DMS, {});
    return idx[username] || [];
  }

  // ─── BASTION MESSAGES ─────────────────────────────────────────────────
  function getBastionChannelMessages(bastionKey, channelId) {
    const all = get(KEY_BAST_MSGS, {});
    return all[`${bastionKey}_${channelId}`] || [];
  }

  function sendBastionChannelMessage(bastionKey, channelId, fromUsername, text) {
    const all = get(KEY_BAST_MSGS, {});
    const k = `${bastionKey}_${channelId}`;
    if (!all[k]) all[k] = [];
    const now = new Date();
    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      from: fromUsername,
      text,
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: now.toISOString()
    };
    all[k].push(msg);
    // Cap at 500 messages per channel
    if (all[k].length > 500) all[k] = all[k].slice(-500);
    set(KEY_BAST_MSGS, all);
    broadcast('bastion_msg', { bastionKey, channelId, msg });
    return msg;
  }

  function addReaction(bastionKey, channelId, msgId, emoji, username) {
    const all = get(KEY_BAST_MSGS, {});
    const k = `${bastionKey}_${channelId}`;
    const msgs = all[k] || [];
    const msg = msgs.find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(username);
    if (idx !== -1) msg.reactions[emoji].splice(idx, 1);
    else msg.reactions[emoji].push(username);
    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    set(KEY_BAST_MSGS, all);
  }

  // ─── POLLING / REAL-TIME ─────────────────────────────────────────────
  let _pollInterval = null;
  let _lastNotifCount = 0;
  let _pollCallbacks = {};

  function startPolling(username, callbacks = {}) {
    _pollCallbacks = callbacks;
    stopPolling();

    // Listen via BroadcastChannel (cross-tab, instant)
    if (bc) {
      bc.onmessage = (e) => {
        const { type, data } = e.data;
        if (!data) return;

        if (type === 'notification' && data.to === username) {
          _pollCallbacks.onNewNotification?.(data.notif);
        }
        if (type === 'dm' && data.to === username) {
          _pollCallbacks.onNewDM?.(data);
        }
        if (type === 'friend_request' && data.to === username) {
          _pollCallbacks.onFriendRequest?.(data);
        }
        if (type === 'friend_accept' && data.to === username) {
          _pollCallbacks.onFriendAccept?.(data);
        }
        if (type === 'status') {
          _pollCallbacks.onStatusChange?.(data);
        }
      };
    }

    // Fallback: poll localStorage every 2 seconds
    _pollInterval = setInterval(() => {
      const count = getUnreadCount(username);
      if (count !== _lastNotifCount) {
        const notifs = getNotifications(username);
        const newest = notifs.find(n => !n.read);
        if (newest) _pollCallbacks.onNewNotification?.(newest);
        _lastNotifCount = count;
      }
    }, 2000);

    _lastNotifCount = getUnreadCount(username);
  }

  function stopPolling() {
    clearInterval(_pollInterval);
    _pollInterval = null;
    if (bc) bc.onmessage = null;
  }

  // ─── AUDIO ────────────────────────────────────────────────────────────
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
    } catch(e) {}
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────────
  return {
    // Auth
    register, login, logout, getCurrentUsername,
    // Users
    getUsers, getUserByName, saveUserObject, initUser,
    // Status
    getStatus, setStatus,
    // Notifications
    getNotifications, addNotification, markNotificationsRead, getUnreadCount,
    // Friends
    sendFriendRequest, acceptFriendRequest: acceptFriendRequest,
    declineFriendRequest, removeFriend,
    // DMs
    getDMMessages, sendDMMessage, getRecentDMPartners,
    // Bastion messages
    getBastionChannelMessages, sendBastionChannelMessage, addReaction,
    // Polling
    startPolling, stopPolling,
    // Utils
    playNotificationSound,
    // Accept alias for legacy code
    acceptFriend: acceptFriendRequest,
  };

})();
