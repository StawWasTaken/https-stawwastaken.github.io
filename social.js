// ── FORTIZED SOCIAL ENGINE ────────────────────────────────────────────────────
// Handles cross-user friend requests, notifications, and social data via localStorage

const FortizedSocial = (() => {

  // ── STORAGE KEYS ──────────────────────────────────────────────────────────
  const USERS_KEY = 'fortized_users';
  const CURRENT_KEY = 'fortized_current_user';

  // ── HELPERS ───────────────────────────────────────────────────────────────
  function getUsers() {
    return JSON.parse(localStorage.getItem(USERS_KEY)) || [];
  }
  function saveUsers(users) {
    localStorage.setItem(USERS_KEY, JSON.stringify(users));
  }
  function getCurrentUsername() {
    return localStorage.getItem(CURRENT_KEY);
  }
  function getUserByName(name) {
    return getUsers().find(u => u.username === name) || null;
  }
  function updateUser(updatedUser) {
    const users = getUsers();
    const idx = users.findIndex(u => u.username === updatedUser.username);
    if (idx > -1) {
      users[idx] = updatedUser;
      saveUsers(users);
    }
  }

  // ── NOTIFICATIONS ─────────────────────────────────────────────────────────
  // Stored on the target user's record under user.notifications = [{id, type, from, data, read, time}]
  function pushNotification(targetUsername, notification) {
    const users = getUsers();
    const idx = users.findIndex(u => u.username === targetUsername);
    if (idx === -1) return false;
    if (!Array.isArray(users[idx].notifications)) users[idx].notifications = [];
    notification.id = Date.now() + Math.random().toString(36).slice(2);
    notification.time = new Date().toISOString();
    notification.read = false;
    users[idx].notifications.unshift(notification);
    // cap at 50
    users[idx].notifications = users[idx].notifications.slice(0, 50);
    saveUsers(users);
    return true;
  }

  function getNotifications(username) {
    const user = getUserByName(username);
    return user?.notifications || [];
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

  // ── FRIEND REQUESTS ───────────────────────────────────────────────────────
  function sendFriendRequest(fromUsername, toUsername) {
    if (fromUsername === toUsername) return { ok: false, msg: "You can't add yourself." };

    const toUser = getUserByName(toUsername);
    if (!toUser) return { ok: false, msg: 'User not found.' };

    const fromUser = getUserByName(fromUsername);
    if (!fromUser) return { ok: false, msg: 'Session error.' };

    // already friends?
    if (Array.isArray(fromUser.friends) && fromUser.friends.includes(toUsername)) {
      return { ok: false, msg: 'Already friends!' };
    }

    // pending outgoing?
    const outgoing = (fromUser.friendRequestsSent || []);
    if (outgoing.includes(toUsername)) return { ok: false, msg: 'Request already sent.' };

    // pending incoming (they already sent to you)?
    const incoming = (fromUser.friendRequestsReceived || []);
    if (incoming.includes(toUsername)) {
      // auto-accept
      return acceptFriendRequest(fromUsername, toUsername);
    }

    // Write outgoing on sender
    const users = getUsers();
    const fromIdx = users.findIndex(u => u.username === fromUsername);
    const toIdx = users.findIndex(u => u.username === toUsername);
    if (!Array.isArray(users[fromIdx].friendRequestsSent)) users[fromIdx].friendRequestsSent = [];
    users[fromIdx].friendRequestsSent.push(toUsername);
    // Write incoming on receiver
    if (!Array.isArray(users[toIdx].friendRequestsReceived)) users[toIdx].friendRequestsReceived = [];
    users[toIdx].friendRequestsReceived.push(fromUsername);
    saveUsers(users);

    // Notification to receiver
    pushNotification(toUsername, {
      type: 'friend_request',
      from: fromUsername,
      data: { from: fromUsername }
    });

    return { ok: true, msg: `Friend request sent to ${toUsername}!` };
  }

  function acceptFriendRequest(currentUsername, fromUsername) {
    const users = getUsers();
    const meIdx = users.findIndex(u => u.username === currentUsername);
    const themIdx = users.findIndex(u => u.username === fromUsername);
    if (meIdx === -1 || themIdx === -1) return { ok: false, msg: 'User not found.' };

    // Add to friends lists
    if (!Array.isArray(users[meIdx].friends)) users[meIdx].friends = [];
    if (!Array.isArray(users[themIdx].friends)) users[themIdx].friends = [];
    if (!users[meIdx].friends.includes(fromUsername)) users[meIdx].friends.push(fromUsername);
    if (!users[themIdx].friends.includes(currentUsername)) users[themIdx].friends.push(currentUsername);

    // Remove pending requests
    users[meIdx].friendRequestsReceived = (users[meIdx].friendRequestsReceived || []).filter(u => u !== fromUsername);
    users[themIdx].friendRequestsSent = (users[themIdx].friendRequestsSent || []).filter(u => u !== currentUsername);

    saveUsers(users);

    // Notify the original sender
    pushNotification(fromUsername, {
      type: 'friend_accept',
      from: currentUsername,
      data: { from: currentUsername }
    });

    return { ok: true, msg: `You are now friends with ${fromUsername}!` };
  }

  function declineFriendRequest(currentUsername, fromUsername) {
    const users = getUsers();
    const meIdx = users.findIndex(u => u.username === currentUsername);
    const themIdx = users.findIndex(u => u.username === fromUsername);
    if (meIdx !== -1) {
      users[meIdx].friendRequestsReceived = (users[meIdx].friendRequestsReceived || []).filter(u => u !== fromUsername);
    }
    if (themIdx !== -1) {
      users[themIdx].friendRequestsSent = (users[themIdx].friendRequestsSent || []).filter(u => u !== currentUsername);
    }
    saveUsers(users);
    return { ok: true, msg: `Request from ${fromUsername} declined.` };
  }

  function removeFriend(currentUsername, friendUsername) {
    const users = getUsers();
    const meIdx = users.findIndex(u => u.username === currentUsername);
    const themIdx = users.findIndex(u => u.username === friendUsername);
    if (meIdx !== -1) users[meIdx].friends = (users[meIdx].friends || []).filter(u => u !== friendUsername);
    if (themIdx !== -1) users[themIdx].friends = (users[themIdx].friends || []).filter(u => u !== currentUsername);
    saveUsers(users);
    return { ok: true, msg: `Removed ${friendUsername} from friends.` };
  }

  function getPendingRequests(username) {
    const user = getUserByName(username);
    return {
      incoming: user?.friendRequestsReceived || [],
      outgoing: user?.friendRequestsSent || []
    };
  }

  // ── DM SYNC ───────────────────────────────────────────────────────────────
  // DMs are stored in a shared key so both users see messages
  function getDMKey(userA, userB) {
    return 'fortized_dm_' + [userA, userB].sort().join('_');
  }

  function getDMMessages(userA, userB) {
    const key = getDMKey(userA, userB);
    return JSON.parse(localStorage.getItem(key)) || [];
  }

  function sendDMMessage(fromUsername, toUsername, text) {
    const key = getDMKey(fromUsername, toUsername);
    const msgs = getDMMessages(fromUsername, toUsername);
    const now = new Date();
    const msg = {
      id: Date.now() + Math.random().toString(36).slice(2),
      from: fromUsername,
      text,
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: now.toISOString()
    };
    msgs.push(msg);
    localStorage.setItem(key, JSON.stringify(msgs));

    // Notify receiver
    pushNotification(toUsername, {
      type: 'dm',
      from: fromUsername,
      data: { preview: text.slice(0, 60) }
    });

    return msg;
  }

  function getRecentDMPartners(username) {
    // scan all keys
    const prefix = 'fortized_dm_';
    const partners = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key.startsWith(prefix)) continue;
      const parts = key.slice(prefix.length).split('_');
      if (parts.includes(username)) {
        const partner = parts.find(p => p !== username);
        if (partner && !partners.includes(partner)) partners.push(partner);
      }
    }
    return partners;
  }

  // ── BASTION SHARED DATA ───────────────────────────────────────────────────
  // Public bastions store channel messages in shared keys
  function getBastionKey(bastionId) {
    return 'fortized_bastion_' + bastionId;
  }

  function getBastionChannelKey(bastionId, channelName) {
    return `fortized_bastion_${bastionId}_ch_${channelName}`;
  }

  function getBastionChannelMessages(bastionId, channelName) {
    const key = getBastionChannelKey(bastionId, channelName);
    return JSON.parse(localStorage.getItem(key)) || [];
  }

  function sendBastionChannelMessage(bastionId, channelName, fromUsername, text) {
    const key = getBastionChannelKey(bastionId, channelName);
    const msgs = getBastionChannelMessages(bastionId, channelName);
    const now = new Date();
    const msg = {
      id: Date.now() + Math.random().toString(36).slice(2),
      from: fromUsername,
      text,
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      timestamp: now.toISOString(),
      reactions: {}
    };
    msgs.push(msg);
    localStorage.setItem(key, JSON.stringify(msgs));
    return msg;
  }

  function addReaction(bastionId, channelName, msgId, emoji, username) {
    const key = getBastionChannelKey(bastionId, channelName);
    const msgs = getBastionChannelMessages(bastionId, channelName);
    const msg = msgs.find(m => m.id === msgId);
    if (!msg) return;
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const idx = msg.reactions[emoji].indexOf(username);
    if (idx === -1) {
      msg.reactions[emoji].push(username);
    } else {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    }
    localStorage.setItem(key, JSON.stringify(msgs));
    return msg;
  }

  // ── ACTIVITY / STATUS ──────────────────────────────────────────────────────
  function setStatus(username, status, activity) {
    const users = getUsers();
    const idx = users.findIndex(u => u.username === username);
    if (idx === -1) return;
    users[idx].status = status; // 'online' | 'away' | 'dnd' | 'invisible'
    users[idx].activity = activity || null;
    users[idx].lastSeen = new Date().toISOString();
    saveUsers(users);
  }

  function getStatus(username) {
    const user = getUserByName(username);
    if (!user) return 'offline';
    if (!user.lastSeen) return 'offline';
    const diff = Date.now() - new Date(user.lastSeen).getTime();
    if (diff > 300000) return 'offline'; // 5 min
    return user.status || 'online';
  }

  // ── SOUND ──────────────────────────────────────────────────────────────────
  let audioCtx = null;
  function playNotificationSound() {
    try {
      // Try loading the mp3 first
      const audio = new Audio('fortized notification.mp3');
      audio.volume = 0.15;
      audio.play().catch(() => {
        // Fallback: generate a soft chime with Web Audio API
        playSyntheticChime();
      });
    } catch (e) {
      playSyntheticChime();
    }
  }

  function playSyntheticChime() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtx;
      const now = ctx.currentTime;
      // Soft two-note chime
      const notes = [880, 1108];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + i * 0.12);
        gain.gain.linearRampToValueAtTime(0.08, now + i * 0.12 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.12 + 0.5);
        osc.start(now + i * 0.12);
        osc.stop(now + i * 0.12 + 0.6);
      });
    } catch (e) { /* silent fail */ }
  }

  // ── POLLING ───────────────────────────────────────────────────────────────
  // Simple poll interval to check for new notifications/messages
  let pollInterval = null;
  let lastNotifCount = 0;
  let onNewNotification = null;
  let onNewDM = null;

  function startPolling(username, callbacks) {
    if (callbacks.onNewNotification) onNewNotification = callbacks.onNewNotification;
    if (callbacks.onNewDM) onNewDM = callbacks.onNewDM;
    if (pollInterval) clearInterval(pollInterval);
    lastNotifCount = getUnreadCount(username);
    pollInterval = setInterval(() => {
      const count = getUnreadCount(username);
      if (count > lastNotifCount) {
        const newNotifs = getNotifications(username).slice(0, count - lastNotifCount);
        newNotifs.forEach(n => {
          if (onNewNotification) onNewNotification(n);
        });
        lastNotifCount = count;
        playNotificationSound();
      }
    }, 2000);
  }

  function stopPolling() {
    if (pollInterval) clearInterval(pollInterval);
  }

  // ── PUBLIC API ─────────────────────────────────────────────────────────────
  return {
    getUsers, getCurrentUsername, getUserByName, updateUser,
    // Notifications
    pushNotification, getNotifications, markNotificationsRead, getUnreadCount,
    // Friends
    sendFriendRequest, acceptFriendRequest, declineFriendRequest, removeFriend, getPendingRequests,
    // DMs
    getDMMessages, sendDMMessage, getRecentDMPartners,
    // Bastion messages
    getBastionChannelMessages, sendBastionChannelMessage, addReaction,
    // Status
    setStatus, getStatus,
    // Sound
    playNotificationSound, playSyntheticChime,
    // Polling
    startPolling, stopPolling
  };
})();

// Export for module use
if (typeof module !== 'undefined') module.exports = FortizedSocial;
