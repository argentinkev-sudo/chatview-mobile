import React, { useState, useEffect, useRef, useCallback } from "react";
import io from "socket.io-client";
import SimplePeer from "simple-peer";
import "./App.css";

const SERVER_URL = "https://chatapp-server-e97e.onrender.com";

// ─── SONS ────────────────────────────────────────────────────────────────────
const joinSound = new Audio("https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3");
const leaveSound = new Audio("https://assets.mixkit.co/active_storage/sfx/2870/2870-preview.mp3");
joinSound.volume = 0.5;
leaveSound.volume = 0.5;

// ─── HELPERS ────────────────────────────────────────────────────────────────
function escapeHtml(str = "") {
  return str.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function formatMentions(text) {
  return text.replace(/@(\w+)/g, '<span class="mention">@$1</span>');
}
function formatLinks(text) {
  return text.replace(/(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi, (url) => {
    const full = url.startsWith("www.") ? "https://" + url : url;
    return `<a href="${full}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`;
  });
}
function formatDate(ts) {
  const d = new Date(ts), now = new Date();
  const time = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `Aujourd'hui à ${time}`;
  const yest = new Date(now); yest.setDate(yest.getDate()-1);
  if (d.toDateString() === yest.toDateString()) return `Hier à ${time}`;
  return `${d.getDate()} ${d.toLocaleDateString("fr-FR",{month:"long"})} à ${time}`;
}
function avatarUrl(av) {
  if (!av || av === "null") return null;
  return av.startsWith("http") ? av : SERVER_URL + av;
}
function Avatar({ av, username, size = 36 }) {
  const url = avatarUrl(av);
  return url
    ? <img src={url} alt={username} style={{width:size,height:size,borderRadius:"50%",objectFit:"cover"}} />
    : <span className="avatar-letter" style={{width:size,height:size,fontSize:size*0.4}}>{(username||"?")[0].toUpperCase()}</span>;
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function App() {
  const [auth, setAuth] = useState(() => ({
    token: localStorage.getItem("token"),
    username: localStorage.getItem("username"),
    avatar: localStorage.getItem("avatar"),
  }));

  if (!auth.token) return <AuthScreen onAuth={setAuth} />;
  return <ChatApp auth={auth} onLogout={() => { localStorage.clear(); setAuth({}); }} />;
}

// ─── AUTH ────────────────────────────────────────────────────────────────────
function AuthScreen({ onAuth }) {
  const [tab, setTab] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!username || !password) return setError("Remplis tous les champs");
    setError(""); setLoading(true);
    try {
      const res = await fetch(SERVER_URL + (tab === "login" ? "/login" : "/register"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || "Erreur"); setLoading(false); return; }
      localStorage.setItem("token", data.token);
      localStorage.setItem("username", data.username);
      if (data.avatar) localStorage.setItem("avatar", data.avatar);
      onAuth({ token: data.token, username: data.username, avatar: data.avatar });
    } catch { setError("Impossible de contacter le serveur"); setLoading(false); }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">
          <span className="logo-icon">💬</span>
          <h1>ChatView</h1>
          <p>Bienvenue sur ChatView Mobile</p>
        </div>
        <div className="auth-tabs">
          <button className={tab==="login"?"active":""} onClick={()=>setTab("login")}>Connexion</button>
          <button className={tab==="register"?"active":""} onClick={()=>setTab("register")}>Inscription</button>
        </div>
        <div className="auth-form">
          <input
            type="text" placeholder="Nom d'utilisateur" value={username}
            onChange={e=>setUsername(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&submit()}
          />
          <input
            type="password" placeholder="Mot de passe" value={password}
            onChange={e=>setPassword(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&submit()}
          />
          {error && <p className="auth-error">{error}</p>}
          <button className="auth-submit" onClick={submit} disabled={loading}>
            {loading ? "..." : tab==="login" ? "Se connecter" : "S'inscrire"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── CHAT APP ────────────────────────────────────────────────────────────────
function ChatApp({ auth, onLogout }) {
  const socketRef = useRef(null);
  const [view, setView] = useState("channels");
  const [channels, setChannels] = useState({ text: [], voice: [] });
  const [currentChannel, setCurrentChannel] = useState(null);
  const [currentVoiceChannel, setCurrentVoiceChannel] = useState(null);
  const [messages, setMessages] = useState([]);
  const [unreadCounts, setUnreadCounts] = useState({});
  const [onlineUsers, setOnlineUsers] = useState({});
  const [allUsers, setAllUsers] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [myRole, setMyRole] = useState("user");
  const [showSidebar, setShowSidebar] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // Voice
  const peersRef = useRef({});
  const localStreamRef = useRef(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);
  const [voiceUsers, setVoiceUsers] = useState([]);
  const [speakingUsers, setSpeakingUsers] = useState(new Set());
  const [activeStreams, setActiveStreams] = useState({});
  const [watchingStream, setWatchingStream] = useState(null);
  const audioContextRef = useRef(null);
  const notificationSoundRef = useRef(new Audio("https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3"));

  // Amis & MP
  const [friends, setFriends] = useState([]);
  const [friendRequests, setFriendRequests] = useState([]);
  const [currentPMUser, setCurrentPMUser] = useState(null);
  const [pmMessages, setPmMessages] = useState([]);
  const [unreadPMs, setUnreadPMs] = useState({});

  // ── Service Worker + Permission Notifications ──
  useEffect(() => {
    // Enregistrer le Service Worker
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").then((reg) => {
        console.log("✅ SW enregistré");
      }).catch(e => console.error("SW error:", e));
    }
    // Demander permission notifications
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().then(perm => {
        console.log("Notif permission:", perm);
      });
    }
  }, []);

  // ── Init socket ──
  useEffect(() => {
    const s = io(SERVER_URL, { auth: { token: auth.token } });
    socketRef.current = s;

    s.on("channel_history", (msgs) => setMessages(msgs));
    s.on("new_message", (msg) => {
      if (msg.channelId === currentChannelRef.current) {
        setMessages(prev => [...prev, msg]);
      } else {
        setUnreadCounts(prev => {
          const next = { ...prev, [msg.channelId]: (prev[msg.channelId]||0)+1 };
          const total = Object.values(next).reduce((a,b)=>a+b,0);
          if (navigator.setAppBadge) navigator.setAppBadge(total).catch(()=>{});
          return next;
        });
        // Son de notification
        if (msg.username !== auth.username) {
          notificationSoundRef.current.play().catch(()=>{});
          // Notification système
          if ("Notification" in window && Notification.permission === "granted") {
            navigator.serviceWorker.ready.then(reg => {
              reg.showNotification(`#${msg.channelId} — ${msg.username}`, {
                body: msg.content || "Nouveau message",
                icon: "/icons/icon-192.png",
                badge: "/icons/icon-192.png",
                vibrate: [200, 100, 200],
                tag: msg.channelId,
                renotify: true,
              });
            }).catch(() => {
              // Fallback notification simple
              new Notification(`${msg.username}`, { body: msg.content || "Nouveau message" });
            });
          }
        }
      }
    });
    s.on("message_edited", ({ messageId, content, edited }) => {
      setMessages(prev => prev.map(m => m._id===messageId ? {...m, content, edited} : m));
    });
    s.on("message_deleted", ({ messageId }) => {
      setMessages(prev => prev.filter(m => m._id!==messageId));
    });
    s.on("reaction_updated", ({ messageId, reactions }) => {
      setMessages(prev => prev.map(m => m._id===messageId ? {...m, reactions} : m));
    });
    s.on("online_users", async (list) => {
      const map = {};
      list.forEach(u => { map[u.username] = u; });
      setOnlineUsers(map);
    });
    s.on("voice_rooms_state", (state) => {
      const ch = currentVoiceChannelRef.current;
      if (ch && state[ch]) setVoiceUsers(state[ch]);
    });
    // voice_peers = on arrive dans un salon déjà occupé → on est initiateur
    s.on("voice_peers", async (list) => {
      for (const { peerId, username } of list) createPeerSP(peerId, true, username, s);
    });
    // peer_joined = quelqu'un arrive après nous → pas initiateur
    s.on("peer_joined", async ({ peerId, username }) => {
      createPeerSP(peerId, false, username, s);
      joinSound.play().catch(()=>{});
    });
    s.on("signal", ({ from, signal }) => {
      if (peersRef.current[from]) {
        peersRef.current[from].peer.signal(signal);
      }
    });
    s.on("peer_left", ({ peerId }) => {
      if (peersRef.current[peerId]) {
        peersRef.current[peerId].peer.destroy();
        delete peersRef.current[peerId];
      }
      const audioEl = document.getElementById("audio-" + peerId);
      if (audioEl) audioEl.remove();
      leaveSound.play().catch(()=>{});
    });
    s.on("channel_created", (ch) => {
      setChannels(prev => ({
        ...prev,
        [ch.type]: [...prev[ch.type]||[], ch]
      }));
    });
    s.on("channel_deleted", ({ channelId }) => {
      setChannels(prev => ({
        text: prev.text.filter(c=>c.id!==channelId),
        voice: prev.voice.filter(c=>c.id!==channelId),
      }));
    });

    loadChannels(s, auth.token);
    checkAdmin(auth.token);
    fetchAllUsers();

    // Listener MP reçu
    s.on("pm_received", (msg) => {
      if (currentPMUserRef.current === msg.from) {
        setPmMessages(prev => [...prev, msg]);
      } else {
        setUnreadPMs(prev => ({ ...prev, [msg.from]: (prev[msg.from]||0)+1 }));
        notificationSoundRef.current.play().catch(()=>{});
        if ("Notification" in window && Notification.permission === "granted") {
          navigator.serviceWorker?.ready.then(reg => {
            reg.showNotification(`💬 ${msg.from}`, {
              body: msg.content,
              icon: "/icons/icon-192.png",
              vibrate: [200,100,200],
              tag: "pm-" + msg.from,
              renotify: true,
            });
          }).catch(()=>{});
        }
      }
    });

    return () => s.disconnect();
  }, []);

  // Refs for closures
  const currentChannelRef = useRef(null);
  const currentVoiceChannelRef = useRef(null);
  const currentPMUserRef = useRef(null);
  useEffect(() => { currentChannelRef.current = currentChannel; }, [currentChannel]);
  useEffect(() => { currentVoiceChannelRef.current = currentVoiceChannel; }, [currentVoiceChannel]);
  useEffect(() => { currentPMUserRef.current = currentPMUser; }, [currentPMUser]);

  // ── Fonctions Amis ──
  const loadFriends = async () => {
    try {
      const res = await fetch(SERVER_URL + "/my-friends", {
        headers: { Authorization: "Bearer " + auth.token }
      });
      const data = await res.json();
      setFriends(data.friends || []);
      setFriendRequests(data.requests || []);
    } catch(e) { console.error(e); }
  };

  const sendFriendRequest = async (username) => {
    const res = await fetch(SERVER_URL + "/send-friend-request", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth.token },
      body: JSON.stringify({ targetUsername: username })
    });
    const data = await res.json();
    return data;
  };

  const acceptFriendRequest = async (requestId) => {
    await fetch(SERVER_URL + "/accept-friend-request", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth.token },
      body: JSON.stringify({ requestId })
    });
    loadFriends();
  };

  const rejectFriendRequest = async (requestId) => {
    await fetch(SERVER_URL + "/reject-friend-request", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth.token },
      body: JSON.stringify({ requestId })
    });
    loadFriends();
  };

  const openPM = async (friendUsername) => {
    setCurrentPMUser(friendUsername);
    currentPMUserRef.current = friendUsername;
    setUnreadPMs(prev => ({ ...prev, [friendUsername]: 0 }));
    try {
      const res = await fetch(SERVER_URL + "/load-pm", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth.token },
        body: JSON.stringify({ friendUsername })
      });
      const msgs = await res.json();
      setPmMessages(msgs);
    } catch(e) { console.error(e); }
    setView("pm");
  };

  const sendPM = async (content) => {
    if (!content || !currentPMUser) return;
    const res = await fetch(SERVER_URL + "/send-pm", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth.token },
      body: JSON.stringify({ to: currentPMUser, content })
    });
    const data = await res.json();
    if (data.success) {
      setPmMessages(prev => [...prev, data.message]);
      socketRef.current.emit("pm_sent", { to: currentPMUser, message: data.message });
    }
  };

  const deletePM = async (messageId) => {
    await fetch(SERVER_URL + "/delete-pm", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth.token },
      body: JSON.stringify({ messageId })
    });
    setPmMessages(prev => prev.filter(m => m._id !== messageId));
  };

  const editPM = async (messageId, newContent) => {
    await fetch(SERVER_URL + "/edit-pm", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth.token },
      body: JSON.stringify({ messageId, newContent })
    });
    setPmMessages(prev => prev.map(m => m._id === messageId ? {...m, content: newContent, edited: true} : m));
  };

  const loadChannels = async (s, token) => {
    try {
      const res = await fetch(SERVER_URL + "/channels");
      const data = await res.json();
      setChannels(data);
    } catch (e) { console.error(e); }
  };

  const checkAdmin = async (token) => {
    try {
      const res = await fetch(SERVER_URL + "/is-admin", { headers: { Authorization: "Bearer " + token } });
      const data = await res.json();
      setIsAdmin(data.isAdmin);
      const uRes = await fetch(SERVER_URL + "/all-users");
      const users = await uRes.json();
      const me = users.find(u => u.username === auth.username);
      setMyRole(me?.role || "user");
    } catch {}
  };

  const fetchAllUsers = async () => {
    try {
      const res = await fetch(SERVER_URL + "/all-users");
      setAllUsers(await res.json());
    } catch {}
  };

  // ── Join text channel ──
  const joinTextChannel = (ch) => {
    setCurrentChannel(ch.id);
    setUnreadCounts(prev => {
      const next = { ...prev, [ch.id]: 0 };
      const total = Object.values(next).reduce((a,b)=>a+b,0);
      if (total === 0 && navigator.clearAppBadge) navigator.clearAppBadge().catch(()=>{});
      else if (navigator.setAppBadge) navigator.setAppBadge(total).catch(()=>{});
      return next;
    });
    setMessages([]);
    socketRef.current.emit("join_channel", ch.id);
    setView("chat");
    setShowSidebar(false);
  };

  // ── Voice ──
  const joinVoiceChannel = async (ch) => {
    if (currentVoiceChannel) await leaveVoice();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      });
      localStreamRef.current = stream;
      setCurrentVoiceChannel(ch.id);
      currentVoiceChannelRef.current = ch.id;
      socketRef.current.emit("join_voice", ch.id);
      joinSound.play().catch(()=>{});

      // ── Analyser micro local pour rond vert ──
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      audioContextRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const checkLevel = () => {
        if (!currentVoiceChannelRef.current) return;
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a,b)=>a+b,0) / data.length;
        setSpeakingUsers(prev => {
          const next = new Set(prev);
          if (avg > 15) next.add("__me__");
          else next.delete("__me__");
          return next;
        });
        requestAnimationFrame(checkLevel);
      };
      checkLevel();

      setView("voice");
      setShowSidebar(false);
    } catch { alert("Impossible d'accéder au micro !"); }
  };

  const leaveVoice = async () => {
    if (!currentVoiceChannel) return;
    socketRef.current.emit("leave_voice", currentVoiceChannel);
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach(t=>t.stop()); localStreamRef.current = null; }
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
    Object.keys(peersRef.current).forEach(id => { peersRef.current[id].peer.destroy(); });
    peersRef.current = {};
    document.querySelectorAll(".remote-audio-el").forEach(a => a.remove());
    setCurrentVoiceChannel(null);
    setVoiceUsers([]);
    setSpeakingUsers(new Set());
    setActiveStreams({});
    setWatchingStream(null);
    leaveSound.play().catch(()=>{});
    setView("channels");
  };

  const createPeerSP = (peerId, initiator, username, s) => {
    const peer = new SimplePeer({
      initiator,
      stream: localStreamRef.current,
      trickle: true,
      config: {
        iceServers: [
          { urls: "stun:stun.relay.metered.ca:80" },
          { urls: "turn:global.relay.metered.ca:80", username: "ac2c93513b982ade0cd857b1", credential: "eKC+3dSGWH6uzm5t" },
          { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: "ac2c93513b982ade0cd857b1", credential: "eKC+3dSGWH6uzm5t" },
          { urls: "turn:global.relay.metered.ca:443", username: "ac2c93513b982ade0cd857b1", credential: "eKC+3dSGWH6uzm5t" },
          { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "ac2c93513b982ade0cd857b1", credential: "eKC+3dSGWH6uzm5t" },
        ]
      }
    });
    peer.on("signal", signal => s.emit("signal", { to: peerId, signal }));
    peer.on("stream", stream => {
      const hasVideo = stream.getVideoTracks().length > 0;
      if (hasVideo) {
        // Stream vidéo — partage d'écran
        setActiveStreams(prev => ({ ...prev, [peerId]: { stream, username } }));
      } else {
        // Audio seulement
        const old = document.getElementById("audio-" + peerId);
        if (old) old.remove();
        const audio = document.createElement("audio");
        audio.id = "audio-" + peerId;
        audio.className = "remote-audio-el";
        audio.autoplay = true;
        audio.playsInline = true;
        audio.srcObject = stream;
        document.body.appendChild(audio);
      }
    });
    peer.on("error", e => console.error("SimplePeer error:", e));
    peersRef.current[peerId] = { peer, username };
  };

  const toggleMute = () => {
    const muted = !isMuted;
    setIsMuted(muted);
    if (localStreamRef.current) localStreamRef.current.getAudioTracks().forEach(t => t.enabled = !muted);
  };

  const toggleDeafen = () => setIsDeafened(d => !d);

  const sendMessage = (content) => {
    if (!content || !currentChannel) return;
    socketRef.current.emit("send_message", { channelId: currentChannel, content, type: "text" });
  };

  const deleteMessage = (messageId) => {
    socketRef.current.emit("delete_message", { messageId });
  };

  const editMessage = (messageId, newContent) => {
    socketRef.current.emit("edit_message", { messageId, newContent });
  };

  const addReaction = async (messageId, emoji) => {
    await fetch(SERVER_URL + "/add-reaction", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + auth.token },
      body: JSON.stringify({ messageId, emoji })
    });
  };

  const currentChannelData = [...channels.text, ...channels.voice].find(c => c.id === currentChannel);
  const currentVoiceChannelData = channels.voice?.find(c => c.id === currentVoiceChannel);

  return (
    <div className="app-shell">
      {/* ── Sidebar overlay ── */}
      {showSidebar && <div className="sidebar-overlay" onClick={()=>setShowSidebar(false)} />}
      <aside className={`sidebar ${showSidebar ? "open" : ""}`}>
        <Sidebar
          auth={auth}
          channels={channels}
          currentChannel={currentChannel}
          currentVoiceChannel={currentVoiceChannel}
          unreadCounts={unreadCounts}
          isAdmin={isAdmin}
          onJoinText={joinTextChannel}
          onJoinVoice={joinVoiceChannel}
          onLogout={onLogout}
          onOpenSettings={()=>setShowSettings(true)}
          onClose={()=>setShowSidebar(false)}
          token={auth.token}
          onChannelsReload={()=>loadChannels(socketRef.current, auth.token)}
        />
      </aside>

      {/* ── Main area ── */}
      <div className="main-area">
        {view === "channels" && (
          <HomeView
            channels={channels}
            currentChannel={currentChannel}
            currentVoiceChannel={currentVoiceChannel}
            unreadCounts={unreadCounts}
            isAdmin={isAdmin}
            onJoinText={joinTextChannel}
            onJoinVoice={joinVoiceChannel}
            onOpenSidebar={()=>setShowSidebar(true)}
            auth={auth}
          />
        )}
        {view === "chat" && (
          <ChatView
            channelName={currentChannelData?.name || ""}
            messages={messages}
            auth={auth}
            myRole={myRole}
            isAdmin={isAdmin}
            onSend={sendMessage}
            onDelete={deleteMessage}
            onEdit={editMessage}
            onReact={addReaction}
            onBack={()=>setView("channels")}
            onOpenMembers={()=>setView("members")}
            socket={socketRef.current}
            onlineUsers={onlineUsers}
            currentVoiceChannel={currentVoiceChannel}
            currentVoiceChannelData={currentVoiceChannelData}
            onLeaveVoice={leaveVoice}
            isMuted={isMuted}
            isDeafened={isDeafened}
            onToggleMute={toggleMute}
            onToggleDeafen={toggleDeafen}
          />
        )}
        {view === "voice" && (
          <VoiceView
            channel={currentVoiceChannelData}
            voiceUsers={voiceUsers}
            auth={auth}
            isMuted={isMuted}
            isDeafened={isDeafened}
            onToggleMute={toggleMute}
            onToggleDeafen={toggleDeafen}
            onLeave={leaveVoice}
            onBack={()=>setView("channels")}
            speakingUsers={speakingUsers}
            activeStreams={activeStreams}
            watchingStream={watchingStream}
            onWatchStream={setWatchingStream}
          />
        )}
        {view === "friends" && (
          <FriendsView
            auth={auth}
            friends={friends}
            friendRequests={friendRequests}
            onlineUsers={onlineUsers}
            unreadPMs={unreadPMs}
            onLoadFriends={loadFriends}
            onSendRequest={sendFriendRequest}
            onAccept={acceptFriendRequest}
            onReject={rejectFriendRequest}
            onOpenPM={openPM}
          />
        )}
        {view === "pm" && (
          <PMView
            friendUsername={currentPMUser}
            messages={pmMessages}
            auth={auth}
            onSend={sendPM}
            onDelete={deletePM}
            onEdit={editPM}
            onBack={()=>setView("friends")}
          />
        )}
        {view === "members" && (
          <MembersView
            allUsers={allUsers}
            onlineUsers={onlineUsers}
            onBack={()=>setView("chat")}
          />
        )}
      </div>

      {/* ── Voice mini bar (always visible when in voice) ── */}
      {currentVoiceChannel && view !== "voice" && (
        <div className="voice-mini-bar" onClick={()=>setView("voice")}>
          <span className="voice-mini-dot" />
          <span>{currentVoiceChannelData?.name || "Vocal"}</span>
          <button className="voice-mini-leave" onClick={(e)=>{e.stopPropagation();leaveVoice();}}>✕</button>
        </div>
      )}

      {/* ── Bottom nav ── */}
      <nav className="bottom-nav">
        <button className={view==="channels"?"active":""} onClick={()=>setView("channels")}>
          <span className="nav-icon">💬</span>
          <span>Salons</span>
          {Object.values(unreadCounts).reduce((a,b)=>a+b,0) > 0 && (
            <span className="nav-badge">{Object.values(unreadCounts).reduce((a,b)=>a+b,0)}</span>
          )}
        </button>
        <button className={view==="friends"||view==="pm"?"active":""} onClick={()=>{ loadFriends(); setView("friends"); }}>
          <span className="nav-icon">👥</span>
          <span>Amis</span>
          {Object.values(unreadPMs).reduce((a,b)=>a+b,0) > 0 && (
            <span className="nav-badge">{Object.values(unreadPMs).reduce((a,b)=>a+b,0)}</span>
          )}
        </button>
        <button onClick={()=>setShowSidebar(true)}>
          <span className="nav-icon">☰</span>
          <span>Menu</span>
        </button>
        <button className={view==="members"?"active":""} onClick={()=>setView("members")}>
          <span className="nav-icon">🟢</span>
          <span>Membres</span>
          {Object.values(onlineUsers).length > 0 && (
            <span className="nav-badge">{Object.values(onlineUsers).length}</span>
          )}
        </button>
      </nav>

      {showSettings && (
        <SettingsModal auth={auth} onClose={()=>setShowSettings(false)} token={auth.token} />
      )}
    </div>
  );
}

// ─── SIDEBAR ─────────────────────────────────────────────────────────────────
function Sidebar({ auth, channels, currentChannel, currentVoiceChannel, unreadCounts, isAdmin, onJoinText, onJoinVoice, onLogout, onOpenSettings, onClose, token, onChannelsReload }) {
  const [creating, setCreating] = useState(null); // 'text' | 'voice' | null
  const [newName, setNewName] = useState("");

  const createChannel = async () => {
    if (!newName.trim()) return;
    await fetch(SERVER_URL + "/admin/create-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
      body: JSON.stringify({ name: newName.trim(), type: creating })
    });
    setCreating(null); setNewName("");
    onChannelsReload();
  };

  const deleteChannel = async (id) => {
    if (!confirm("Supprimer ce salon ?")) return;
    await fetch(SERVER_URL + "/admin/delete-channel/" + id, {
      method: "DELETE", headers: { Authorization: "Bearer " + token }
    });
    onChannelsReload();
  };

  return (
    <div className="sidebar-inner">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <span>💬</span>
          <strong>ChatView</strong>
        </div>
        <button className="sidebar-close" onClick={onClose}>✕</button>
      </div>

      <div className="sidebar-user">
        <Avatar av={auth.avatar} username={auth.username} size={38} />
        <div className="sidebar-user-info">
          <span className="sidebar-username">{auth.username}</span>
        </div>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">
          <span>SALONS TEXTUELS</span>
          {isAdmin && <button className="sidebar-add-btn" onClick={()=>setCreating("text")}>+</button>}
        </div>
        {channels.text?.map(ch => (
          <div key={ch.id} className={`sidebar-channel ${currentChannel===ch.id?"active":""}`} onClick={()=>onJoinText(ch)}>
            <span className="ch-hash">#</span>
            <span>{ch.name}</span>
            {unreadCounts[ch.id] > 0 && <span className="channel-badge">{unreadCounts[ch.id]>99?"99+":unreadCounts[ch.id]}</span>}
            {isAdmin && <button className="ch-del-btn" onClick={e=>{e.stopPropagation();deleteChannel(ch.id);}}>🗑️</button>}
          </div>
        ))}
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">
          <span>SALONS VOCAUX</span>
          {isAdmin && <button className="sidebar-add-btn" onClick={()=>setCreating("voice")}>+</button>}
        </div>
        {channels.voice?.map(ch => (
          <div key={ch.id} className={`sidebar-channel ${currentVoiceChannel===ch.id?"active voice-active":""}`} onClick={()=>onJoinVoice(ch)}>
            <span className="ch-hash">🔊</span>
            <span>{ch.name}</span>
            {isAdmin && <button className="ch-del-btn" onClick={e=>{e.stopPropagation();deleteChannel(ch.id);}}>🗑️</button>}
          </div>
        ))}
      </div>

      {creating && (
        <div className="sidebar-create">
          <input autoFocus placeholder={`Nom du salon ${creating}`} value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&createChannel()} />
          <div className="sidebar-create-btns">
            <button onClick={createChannel}>Créer</button>
            <button onClick={()=>setCreating(null)}>Annuler</button>
          </div>
        </div>
      )}

      <div className="sidebar-footer">
        <button className="sidebar-footer-btn" onClick={onOpenSettings}>⚙️ Paramètres</button>
        <button className="sidebar-footer-btn danger" onClick={onLogout}>🚪 Déconnexion</button>
      </div>
    </div>
  );
}

// ─── HOME VIEW ────────────────────────────────────────────────────────────────
function HomeView({ channels, currentChannel, currentVoiceChannel, unreadCounts, isAdmin, onJoinText, onJoinVoice, onOpenSidebar, auth }) {
  const totalUnread = Object.values(unreadCounts).reduce((a,b)=>a+b,0);
  return (
    <div className="home-view">
      <div className="home-header">
        <button className="hamburger" onClick={onOpenSidebar}>☰</button>
        <h2>ChatView</h2>
        <div className="home-avatar">
          <Avatar av={auth.avatar} username={auth.username} size={32} />
        </div>
      </div>

      <div className="home-content">
        <div className="channels-group">
          <div className="channels-group-title">
            <span className="channels-group-icon">💬</span>
            Salons textuels
            {totalUnread > 0 && <span className="group-badge">{totalUnread}</span>}
          </div>
          {channels.text?.map(ch => (
            <div key={ch.id} className={`channel-card ${currentChannel===ch.id?"active":""}`} onClick={()=>onJoinText(ch)}>
              <span className="channel-card-hash">#</span>
              <span className="channel-card-name">{ch.name}</span>
              {unreadCounts[ch.id] > 0 && (
                <span className="channel-badge">{unreadCounts[ch.id]>99?"99+":unreadCounts[ch.id]}</span>
              )}
              <span className="channel-card-arrow">›</span>
            </div>
          ))}
        </div>

        <div className="channels-group">
          <div className="channels-group-title">
            <span className="channels-group-icon">🔊</span>
            Salons vocaux
          </div>
          {channels.voice?.map(ch => (
            <div key={ch.id} className={`channel-card ${currentVoiceChannel===ch.id?"active voice":""}`} onClick={()=>onJoinVoice(ch)}>
              <span className="channel-card-hash">🔊</span>
              <span className="channel-card-name">{ch.name}</span>
              {currentVoiceChannel===ch.id && <span className="channel-card-sub">Connecté</span>}
              <span className="channel-card-arrow">›</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── CHAT VIEW ────────────────────────────────────────────────────────────────
function ChatView({ channelName, messages, auth, myRole, isAdmin, onSend, onDelete, onEdit, onReact, onBack, onOpenMembers, socket, onlineUsers, currentVoiceChannel, currentVoiceChannelData, onLeaveVoice, isMuted, isDeafened, onToggleMute, onToggleDeafen }) {
  const [input, setInput] = useState("");
  const [showEmoji, setShowEmoji] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const [reactionTarget, setReactionTarget] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = () => {
    const t = input.trim();
    if (!t) return;
    onSend(t);
    setInput("");
    setShowEmoji(false);
  };

  const saveEdit = () => {
    if (editText.trim()) onEdit(editingId, editText.trim());
    setEditingId(null);
  };

  const EMOJIS = ["😀","😂","🥰","😎","🤔","😴","😭","😡","👍","👎","❤️","🔥","👏","🎉","💯","✨","😅","🤣","😇","🥳","🤩","😤","🙏","💪","🎊","🍕","🐱","🦋","🌟","💎"];
  const REACTIONS = ["👍","❤️","😂","🔥","👏","😊","🤩","🤔","😅","💩","💪","😱","👌","🎉","✨"];

  return (
    <div className="chat-view">
      {/* Header */}
      <div className="chat-header">
        <button className="back-btn" onClick={onBack}>‹</button>
        <div className="chat-header-info">
          <span className="chat-header-hash">#</span>
          <span className="chat-header-name">{channelName}</span>
        </div>
        <button className="members-btn-icon" onClick={onOpenMembers}>👥</button>
      </div>

      {/* Voice mini bar in chat */}
      {currentVoiceChannel && (
        <div className="voice-in-chat-bar">
          <span className="voice-dot-live" />
          <span>{currentVoiceChannelData?.name}</span>
          <div className="voice-in-chat-controls">
            <button className={isMuted?"muted":""} onClick={onToggleMute}>{isMuted?"🔇":"🎙️"}</button>
            <button className={isDeafened?"deafened":""} onClick={onToggleDeafen}>{isDeafened?"🔕":"🔊"}</button>
            <button onClick={onLeaveVoice}>✕</button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div className="messages-area">
        {messages.length === 0 && (
          <div className="messages-empty">
            <span>💬</span>
            <p>Aucun message pour l'instant.<br/>Sois le premier à écrire !</p>
          </div>
        )}
        {messages.map((msg) => (
          <MessageItem
            key={msg._id}
            msg={msg}
            myUsername={auth.username}
            myRole={myRole}
            isAdmin={isAdmin}
            onDelete={onDelete}
            onEdit={(id) => { setEditingId(id); setEditText(msg.content); }}
            onReact={(id) => setReactionTarget(reactionTarget===id?null:id)}
            reactions={REACTIONS}
            onAddReaction={onReact}
            showReactionPicker={reactionTarget===msg._id}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Edit modal */}
      {editingId && (
        <div className="edit-overlay">
          <div className="edit-modal">
            <p>Modifier le message</p>
            <textarea value={editText} onChange={e=>setEditText(e.target.value)} autoFocus />
            <div className="edit-modal-btns">
              <button onClick={()=>setEditingId(null)}>Annuler</button>
              <button className="primary" onClick={saveEdit}>Sauvegarder</button>
            </div>
          </div>
        </div>
      )}

      {/* Emoji picker */}
      {showEmoji && (
        <div className="emoji-panel">
          {EMOJIS.map(e => (
            <button key={e} className="emoji-btn-item" onClick={()=>{ setInput(i=>i+e); inputRef.current?.focus(); }}>
              {e}
            </button>
          ))}
        </div>
      )}

      {/* Input */}
      <div className="chat-input-bar">
        <button className="emoji-toggle" onClick={()=>setShowEmoji(v=>!v)}>😊</button>
        <input
          ref={inputRef}
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{ if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();} }}
          placeholder={`Message #${channelName}`}
        />
        <button className="send-btn" onClick={send} disabled={!input.trim()}>➤</button>
      </div>
    </div>
  );
}

// ─── MESSAGE ITEM ─────────────────────────────────────────────────────────────
function MessageItem({ msg, myUsername, myRole, isAdmin, onDelete, onEdit, onReact, reactions, onAddReaction, showReactionPicker }) {
  const [showActions, setShowActions] = useState(false);
  const isMine = msg.username === myUsername;
  const canModerate = isMine || isAdmin || myRole === "moderator";

  const isImage = msg.type === "image" || (msg.content && /\.(gif|jpg|jpeg|png)(\?|$)/i.test(msg.content));
  const isGif = msg.content && (msg.content.includes("tenor.com") || msg.content.endsWith(".gif"));

  let contentHtml = "";
  if (msg.type === "image" && msg.fileUrl) {
    const url = msg.fileUrl.startsWith("http") ? msg.fileUrl : SERVER_URL + msg.fileUrl;
    contentHtml = `<img class="msg-image" src="${url}" />`;
  } else if (msg.type === "file" && msg.fileUrl) {
    const url = msg.fileUrl.startsWith("http") ? msg.fileUrl : SERVER_URL + msg.fileUrl;
    contentHtml = `<a class="msg-file" href="${url}" target="_blank">📎 ${msg.fileName}</a>`;
  } else if (isGif) {
    contentHtml = `<img class="msg-image" src="${msg.content}" />`;
  } else if (msg.type === "welcome" && msg.content?.startsWith("WELCOME_CARD:")) {
    const [,username] = msg.content.split(":");
    contentHtml = `<div class="welcome-card">👋 <strong>${escapeHtml(username)}</strong> a rejoint ChatView !</div>`;
  } else {
    contentHtml = formatLinks(formatMentions(escapeHtml(msg.content || "")));
  }

  return (
    <div className={`message-item ${isMine?"mine":""} ${msg.content?.includes("@"+myUsername)?"mentioned":""}`}
         onClick={()=>setShowActions(v=>!v)}>
      <div className="msg-avatar-col">
        <Avatar av={msg.avatar} username={msg.username} size={32} />
      </div>
      <div className="msg-main">
        <div className="msg-header-row">
          <span className={`msg-username role-${msg.role||"user"}`}>{msg.username}</span>
          <span className="msg-time">{formatDate(msg.timestamp)}</span>
          {msg.edited && <span className="msg-edited">(modifié)</span>}
        </div>
        <div className="msg-content-wrap" dangerouslySetInnerHTML={{ __html: contentHtml }} />

        {/* Reactions */}
        {msg.reactions?.length > 0 && (
          <div className="msg-reactions">
            {msg.reactions.map(r => (
              <button key={r.emoji} className="reaction-chip" onClick={e=>{e.stopPropagation();onAddReaction(msg._id,r.emoji);}}>
                {r.emoji} <span>{r.users.length}</span>
              </button>
            ))}
          </div>
        )}

        {/* Reaction picker */}
        {showReactionPicker && (
          <div className="reaction-picker-row" onClick={e=>e.stopPropagation()}>
            {reactions.map(e => (
              <button key={e} onClick={()=>onAddReaction(msg._id,e)}>{e}</button>
            ))}
          </div>
        )}

        {/* Action buttons */}
        {showActions && (
          <div className="msg-action-row" onClick={e=>e.stopPropagation()}>
            <button onClick={()=>{ onReact(msg._id); setShowActions(false); }}>😊</button>
            {isMine && <button onClick={()=>{ onEdit(msg._id); setShowActions(false); }}>✏️</button>}
            {canModerate && <button className="danger" onClick={()=>{ onDelete(msg._id); setShowActions(false); }}>🗑️</button>}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── VOICE VIEW ───────────────────────────────────────────────────────────────
function VoiceView({ channel, voiceUsers, auth, isMuted, isDeafened, onToggleMute, onToggleDeafen, onLeave, onBack, speakingUsers, activeStreams, watchingStream, onWatchStream }) {
  const isMeSpeaking = speakingUsers?.has("__me__") && !isMuted;
  const streamEntries = Object.entries(activeStreams || {});

  return (
    <div className="voice-view">
      <div className="voice-header">
        <button className="back-btn" onClick={onBack}>‹</button>
        <div className="voice-header-info">
          <span className="voice-live-dot" />
          <span>{channel?.name || "Vocal"}</span>
        </div>
        {streamEntries.length > 0 && (
          <button className="stream-watch-btn" onClick={()=>onWatchStream(streamEntries[0][0])}>
            🖥️ Stream
          </button>
        )}
      </div>

      {/* Visionneuse stream */}
      {watchingStream && activeStreams[watchingStream] && (
        <StreamViewer
          stream={activeStreams[watchingStream].stream}
          username={activeStreams[watchingStream].username}
          onClose={()=>onWatchStream(null)}
        />
      )}

      <div className="voice-users-grid">
        {/* Me */}
        <div className={`voice-user-card ${isMuted?"muted":""} ${isMeSpeaking?"speaking":""}`}>
          <div className={`voice-user-avatar-wrap ${isMeSpeaking?"speaking-ring":""}`}>
            <Avatar av={auth.avatar} username={auth.username} size={64} />
            {isMuted && <span className="voice-muted-badge">🔇</span>}
          </div>
          <span className="voice-user-name">{auth.username}</span>
          <span className="voice-user-sub">Vous</span>
        </div>
        {/* Other users */}
        {voiceUsers.filter(u=>(u.username||u)!==auth.username).map((u,i) => {
          const username = u.username || u;
          const isSpeaking = speakingUsers?.has(username);
          const isStreaming = streamEntries.some(([,s])=>s.username===username);
          return (
            <div key={i} className={`voice-user-card ${isSpeaking?"speaking":""}`}>
              <div className={`voice-user-avatar-wrap ${isSpeaking?"speaking-ring":""}`}>
                <Avatar av={u.avatar} username={username} size={64} />
                {isStreaming && <span className="stream-badge">🔴</span>}
              </div>
              <span className="voice-user-name">{username}</span>
              {isStreaming && (
                <button className="watch-stream-btn" onClick={()=>{
                  const entry = streamEntries.find(([,s])=>s.username===username);
                  if (entry) onWatchStream(entry[0]);
                }}>Voir le stream</button>
              )}
            </div>
          );
        })}
      </div>

      <div className="voice-controls">
        <button className={`voice-ctrl-btn ${isMuted?"active":""}`} onClick={onToggleMute}>
          {isMuted ? "🔇" : "🎙️"}
          <span>{isMuted ? "Muet" : "Micro"}</span>
        </button>
        <button className={`voice-ctrl-btn ${isDeafened?"active":""}`} onClick={onToggleDeafen}>
          {isDeafened ? "🔕" : "🔊"}
          <span>{isDeafened ? "Sourd" : "Son"}</span>
        </button>
        <button className="voice-ctrl-btn leave" onClick={onLeave}>
          📵
          <span>Quitter</span>
        </button>
      </div>
    </div>
  );
}

// ─── STREAM VIEWER ────────────────────────────────────────────────────────────
function StreamViewer({ stream, username, onClose }) {
  const videoRef = useRef(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const toggleFullscreen = () => {
    const video = videoRef.current;
    if (!video) return;
    if (!isFullscreen) {
      if (video.requestFullscreen) video.requestFullscreen();
      else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen();
      else if (video.mozRequestFullScreen) video.mozRequestFullScreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    }
    setIsFullscreen(f => !f);
  };

  // Détecter quand on sort du fullscreen via le bouton natif
  useEffect(() => {
    const handler = () => {
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        setIsFullscreen(false);
      }
    };
    document.addEventListener("fullscreenchange", handler);
    document.addEventListener("webkitfullscreenchange", handler);
    return () => {
      document.removeEventListener("fullscreenchange", handler);
      document.removeEventListener("webkitfullscreenchange", handler);
    };
  }, []);

  return (
    <div className="stream-viewer-overlay">
      <div className="stream-viewer-header">
        <span>🔴 Stream de {username}</span>
        <div style={{display:"flex",gap:8}}>
          <button onClick={toggleFullscreen} title="Plein écran">
            {isFullscreen ? "⊡" : "⛶"}
          </button>
          <button onClick={onClose}>✕</button>
        </div>
      </div>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        className="stream-viewer-video"
        onClick={toggleFullscreen}
        style={{cursor:"pointer"}}
      />
      <div className="stream-viewer-hint">Appuie sur la vidéo pour le plein écran</div>
    </div>
  );
}

// ─── FRIENDS VIEW ─────────────────────────────────────────────────────────────
function FriendsView({ auth, friends, friendRequests, onlineUsers, unreadPMs, onLoadFriends, onSendRequest, onAccept, onReject, onOpenPM }) {
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [searchUsername, setSearchUsername] = useState("");
  const [searchMsg, setSearchMsg] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => { onLoadFriends(); }, []);

  const handleSendRequest = async () => {
    if (!searchUsername.trim()) return;
    setLoading(true);
    const data = await onSendRequest(searchUsername.trim());
    setSearchMsg(data.success ? "✅ Demande envoyée !" : "❌ " + (data.error || "Erreur"));
    setLoading(false);
    if (data.success) { setSearchUsername(""); setTimeout(()=>setSearchMsg(""),3000); }
  };

  return (
    <div className="friends-view">
      <div className="friends-header">
        <h2>Amis</h2>
        <button className="add-friend-btn" onClick={()=>setShowAddFriend(v=>!v)}>➕</button>
      </div>

      {showAddFriend && (
        <div className="add-friend-bar">
          <input
            placeholder="Nom d'utilisateur..."
            value={searchUsername}
            onChange={e=>setSearchUsername(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&handleSendRequest()}
          />
          <button onClick={handleSendRequest} disabled={loading}>
            {loading ? "..." : "Envoyer"}
          </button>
          {searchMsg && <p className={`friend-search-msg ${searchMsg.startsWith("✅")?"success":"error"}`}>{searchMsg}</p>}
        </div>
      )}

      {/* Demandes reçues */}
      {friendRequests.length > 0 && (
        <div className="friends-section">
          <div className="friends-section-title">DEMANDES — {friendRequests.length}</div>
          {friendRequests.map(req => (
            <div key={req._id} className="friend-request-item">
              <span className="friend-request-from">👤 {req.from}</span>
              <div className="friend-request-btns">
                <button className="accept-btn" onClick={()=>onAccept(req._id)}>✓</button>
                <button className="reject-btn" onClick={()=>onReject(req._id)}>✗</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Liste amis */}
      <div className="friends-section">
        <div className="friends-section-title">AMIS — {friends.length}</div>
        {friends.length === 0 && (
          <div className="friends-empty">
            <span>👥</span>
            <p>Aucun ami pour l'instant.<br/>Ajoute quelqu'un avec ➕</p>
          </div>
        )}
        {friends.map(friend => {
          const isOnline = !!onlineUsers[friend.username];
          const unread = unreadPMs[friend.username] || 0;
          return (
            <div key={friend.username} className="friend-item" onClick={()=>onOpenPM(friend.username)}>
              <div className="friend-avatar-wrap">
                <Avatar av={friend.avatar} username={friend.username} size={42} />
                <span className={`status-dot ${isOnline?"online":"offline"}`} />
              </div>
              <div className="friend-info">
                <span className="friend-name">{friend.username}</span>
                <span className="friend-status">{isOnline ? "En ligne" : "Hors ligne"}</span>
              </div>
              <div className="friend-actions">
                {unread > 0 && <span className="pm-badge">{unread > 99 ? "99+" : unread}</span>}
                <span className="friend-chat-icon">💬</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── PM VIEW ──────────────────────────────────────────────────────────────────
function PMView({ friendUsername, messages, auth, onSend, onDelete, onEdit, onBack }) {
  const [input, setInput] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  const messagesEndRef = useRef(null);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const send = () => {
    const t = input.trim();
    if (!t) return;
    onSend(t);
    setInput("");
  };

  const saveEdit = () => {
    if (editText.trim()) onEdit(editingId, editText.trim());
    setEditingId(null);
  };

  return (
    <div className="chat-view">
      <div className="chat-header">
        <button className="back-btn" onClick={onBack}>‹</button>
        <div className="chat-header-info">
          <span style={{fontSize:18}}>💬</span>
          <span className="chat-header-name">{friendUsername}</span>
        </div>
      </div>

      <div className="messages-area">
        {messages.length === 0 && (
          <div className="messages-empty">
            <span>💬</span>
            <p>Début de votre conversation avec<br/><strong>{friendUsername}</strong></p>
          </div>
        )}
        {messages.map((msg, i) => {
          const isMine = msg.from === auth.username;
          const [showActions, setShowActions] = useState(false);
          return (
            <div key={msg._id || i} className={`message-item ${isMine?"mine":""}`} onClick={()=>setShowActions(v=>!v)}>
              <div className="msg-avatar-col">
                <Avatar av={isMine ? auth.avatar : null} username={isMine ? auth.username : friendUsername} size={32} />
              </div>
              <div className="msg-main">
                <div className="msg-header-row">
                  <span className="msg-username">{isMine ? auth.username : friendUsername}</span>
                  <span className="msg-time">{formatDate(msg.timestamp)}</span>
                  {msg.edited && <span className="msg-edited">(modifié)</span>}
                </div>
                <div className="msg-content-wrap">{msg.content}</div>
                {showActions && isMine && (
                  <div className="msg-action-row" onClick={e=>e.stopPropagation()}>
                    <button onClick={()=>{ setEditingId(msg._id); setEditText(msg.content); setShowActions(false); }}>✏️</button>
                    <button className="danger" onClick={()=>{ onDelete(msg._id); setShowActions(false); }}>🗑️</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {editingId && (
        <div className="edit-overlay">
          <div className="edit-modal">
            <p>Modifier le message</p>
            <textarea value={editText} onChange={e=>setEditText(e.target.value)} autoFocus />
            <div className="edit-modal-btns">
              <button onClick={()=>setEditingId(null)}>Annuler</button>
              <button className="primary" onClick={saveEdit}>Sauvegarder</button>
            </div>
          </div>
        </div>
      )}

      <div className="chat-input-bar">
        <input
          value={input}
          onChange={e=>setInput(e.target.value)}
          onKeyDown={e=>{ if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();send();} }}
          placeholder={`Message à ${friendUsername}...`}
        />
        <button className="send-btn" onClick={send} disabled={!input.trim()}>➤</button>
      </div>
    </div>
  );
}

// ─── MEMBERS VIEW ─────────────────────────────────────────────────────────────
function MembersView({ allUsers, onlineUsers, onBack }) {
  const online = allUsers.filter(u => onlineUsers[u.username]);
  const offline = allUsers.filter(u => !onlineUsers[u.username]);
  return (
    <div className="members-view">
      <div className="members-header">
        <button className="back-btn" onClick={onBack}>‹</button>
        <h3>Membres</h3>
      </div>
      <div className="members-list">
        {online.length > 0 && <>
          <div className="members-section-title">EN LIGNE — {online.length}</div>
          {online.map(u => (
            <div key={u.username} className="member-row">
              <div className="member-row-avatar">
                <Avatar av={u.avatar} username={u.username} size={38} />
                <span className="status-dot online" />
              </div>
              <span className={`member-row-name role-${u.role||"user"}`}>{u.username}</span>
              <span className="member-row-role">{u.role==="admin"?"👑":u.role==="moderator"?"🛡️":""}</span>
            </div>
          ))}
        </>}
        {offline.length > 0 && <>
          <div className="members-section-title">HORS LIGNE — {offline.length}</div>
          {offline.map(u => (
            <div key={u.username} className="member-row offline">
              <div className="member-row-avatar">
                <Avatar av={u.avatar} username={u.username} size={38} />
                <span className="status-dot offline" />
              </div>
              <span className="member-row-name">{u.username}</span>
            </div>
          ))}
        </>}
      </div>
    </div>
  );
}

// ─── SETTINGS MODAL ───────────────────────────────────────────────────────────
function SettingsModal({ auth, onClose, token }) {
  const [uploading, setUploading] = useState(false);

  const changeAvatar = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5*1024*1024) { alert("Image trop grande (max 5MB)"); return; }
    setUploading(true);
    const fd = new FormData(); fd.append("avatar", file);
    const res = await fetch(SERVER_URL + "/upload-avatar", {
      method: "POST", headers: { Authorization: "Bearer " + token }, body: fd
    });
    const data = await res.json();
    if (data.avatar) {
      localStorage.setItem("avatar", data.avatar);
      alert("Avatar mis à jour ! Recharge la page.");
    }
    setUploading(false);
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={e=>e.stopPropagation()}>
        <div className="settings-header">
          <h3>Paramètres</h3>
          <button onClick={onClose}>✕</button>
        </div>
        <div className="settings-body">
          <div className="settings-section">
            <div className="settings-section-title">Mon profil</div>
            <div className="settings-avatar-row">
              <Avatar av={auth.avatar} username={auth.username} size={56} />
              <div>
                <div className="settings-username">{auth.username}</div>
                <label className="settings-avatar-btn">
                  {uploading ? "Upload..." : "Changer l'avatar"}
                  <input type="file" accept="image/*" style={{display:"none"}} onChange={changeAvatar} />
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
