const SERVER_URL = 'https://chatapp-server-e97e.onrender.com';

let socket = null, myUsername = null, myToken = null, myAvatar = null, currentPMUser = null;
let currentChannel = null, currentVoiceChannel = null;
let isMuted = false, isDeafened = false, isSharing = false;
let unreadPMs = {};
let peers = {}, localStream = null, screenStream = null;
let streamQuality = localStorage.getItem('streamQuality') || 'hd'; // 'hd' ou 'sd'
let streamingUsers = new Set(); // Utilisateurs qui stream actuellement
let micGainNode = null;
let audioContextInstance = null;
let compressorEnabled = localStorage.getItem('audioCompressor') === 'true';
let noiseGateEnabled = localStorage.getItem('noiseGate') === 'true';
let equalizerEnabled = localStorage.getItem('audioEqualizer') === 'true';

const $ = id => document.getElementById(id);

// Événements globaux (chargés une seule fois)
window.addEventListener('DOMContentLoaded', () => {
  $('profile-close-btn').onclick = () => {
    $('user-profile-modal').classList.add('hidden');
  };

   // Fermer le modal édition PM
  $('edit-pm-close-btn').onclick = () => {
    $('edit-pm-modal').classList.add('hidden');
    $('edit-pm-input').value = '';
  };
});

// Notifications
let unreadCounts = {}; // { channelId: count }
let onlineUsers = {};
const notificationSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2354/2354-preview.mp3');
const joinSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3');
const leaveSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2870/2870-preview.mp3');
const mentionSound = new Audio('https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3');

// AUTH
let isRegistering = false;
$('tab-login').onclick = () => switchTab('login');
$('tab-register').onclick = () => switchTab('register');

function switchTab(tab) {
  isRegistering = tab === 'register';
  $('tab-login').classList.toggle('act', !isRegistering);
  $('tab-register').classList.toggle('act', isRegistering);
  $('auth-submit').textContent = isRegistering ? "S'inscrire" : 'Se connecter';
  $('auth-error').textContent = '';
}

$('auth-submit').onclick = async () => {
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  if (!username || !password) return ($('auth-error').textContent = 'Remplis tous les champs');
  $('auth-error').textContent = '';
  $('auth-submit').disabled = true;
  try {
    const route = isRegistering ? '/register' : '/login';
    const res = await fetch(SERVER_URL + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { $('auth-error').textContent = data.error; $('auth-submit').disabled = false; return; }
    myToken = data.token;
    myUsername = data.username;
    myAvatar = data.avatar;
    localStorage.setItem('token', myToken);
    localStorage.setItem('username', myUsername);
    if (myAvatar) {
      localStorage.setItem('avatar', myAvatar);
    }
    startApp();
  } catch {
    $('auth-error').textContent = 'Impossible de contacter le serveur';
    $('auth-submit').disabled = false;
  }
};

// Toggle entre ChatView et Amis
$('chatview-btn').onclick = () => {
  // Activer ChatView
  $('chatview-btn').classList.add('active');
  $('friends-btn').classList.remove('active');
  
  // Afficher sidebar ChatView, cacher sidebar Amis
  document.querySelector('.sidebar').classList.remove('hidden');
  document.querySelector('.friends-sidebar').classList.add('hidden');
};

$('friends-btn').onclick = () => {
  // Activer Amis
  $('friends-btn').classList.add('active');
  $('chatview-btn').classList.remove('active');
  
  // Afficher sidebar Amis, cacher sidebar ChatView
  document.querySelector('.sidebar').classList.add('hidden');
  document.querySelector('.friends-sidebar').classList.remove('hidden');
  loadFriends();
};

// Ajouter un ami
document.addEventListener('DOMContentLoaded', () => {
  const btnAddFriend = document.querySelector('.btn-add-friend');
  if (btnAddFriend) {
    btnAddFriend.onclick = () => {
      $('add-friend-modal').classList.remove('hidden');
    };
  }
  
  // Fermer le modal
  $('add-friend-close-btn').onclick = () => {
    $('add-friend-modal').classList.add('hidden');
    $('friend-username-input').value = '';
  };
  
  // Envoyer la demande
  $('send-friend-request-btn').onclick = () => {
    const username = $('friend-username-input').value.trim();
    if (!username) return alert('Entre un nom d\'utilisateur');
    
    fetch(SERVER_URL + '/send-friend-request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + myToken
      },
      body: JSON.stringify({ targetUsername: username })
    })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        alert('Demande envoyée !');
        $('add-friend-modal').classList.add('hidden');
        $('friend-username-input').value = '';
      } else {
        alert(data.error || 'Erreur');
      }
    })
    .catch(err => {
      console.error(err);
      alert('Erreur lors de l\'envoi');
    });
  };
});

// Charger les amis et demandes
async function loadFriends() {
  try {
    const res = await fetch(SERVER_URL + '/my-friends', {
      headers: { 'Authorization': 'Bearer ' + myToken }
    });
    const data = await res.json();
    
    // Afficher demandes
    const requestsList = $('friend-requests-list');
    requestsList.innerHTML = '';
    
    data.requests.forEach(req => {
      const div = document.createElement('div');
      div.className = 'friend-request-item';
      div.innerHTML = `
        <span>${req.from}</span>
        <div class="request-actions">
          <button class="btn-accept" onclick="acceptFriendRequest('${req._id}')">✓</button>
          <button class="btn-reject" onclick="rejectFriendRequest('${req._id}')">✗</button>
        </div>
      `;
      requestsList.appendChild(div);
    });
    
    // Afficher amis
const friendsList = $('friends-list');
friendsList.innerHTML = '';

data.friends.forEach(friend => {
  const div = document.createElement('div');
  div.className = 'friend-item';
  
  // Vérifier si en ligne
  const isOnline = Object.values(onlineUsers).some(u => u.username === friend.username);
  const statusClass = isOnline ? 'online' : 'offline';
  
  // Badge MP non lus
  const unreadCount = unreadPMs[friend.username] || 0;
  const badgeHtml = unreadCount > 0 
    ? `<span class="pm-unread-badge">${unreadCount > 99 ? '99+' : unreadCount}</span>` 
    : '';
  
  div.innerHTML = `
    <span class="${statusClass}">${friend.username}</span>
    <div style="position:relative;display:inline-block;">
      <button class="btn-pm" onclick="openPM('${friend.username}')">💬</button>
      ${badgeHtml}
    </div>
  `;
  friendsList.appendChild(div);
});
    
  } catch (err) {
    console.error('Erreur chargement amis:', err);
  }
}

// Accepter une demande
window.acceptFriendRequest = async (requestId) => {
  try {
    const res = await fetch(SERVER_URL + '/accept-friend-request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + myToken
      },
      body: JSON.stringify({ requestId })
    });
    
    if (res.ok) {
      alert('Ami ajouté !');
      loadFriends(); // Recharger
    }
  } catch (err) {
    console.error(err);
    alert('Erreur');
  }
};

// Refuser une demande
window.rejectFriendRequest = async (requestId) => {
  try {
    const res = await fetch(SERVER_URL + '/reject-friend-request', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + myToken
      },
      body: JSON.stringify({ requestId })
    });
    
    if (res.ok) {
      alert('Demande refusée');
      loadFriends(); // Recharger
    }
  } catch (err) {
    console.error(err);
    alert('Erreur');
  }
};

// Ouvrir conversation privée
window.openPM = async (friendUsername) => {
  // Revenir à la vue ChatView
  $('chatview-btn').classList.add('active');
  $('friends-btn').classList.remove('active');
  document.querySelector('.sidebar').classList.remove('hidden');
  document.querySelector('.friends-sidebar').classList.add('hidden');
  
  // Indiquer qu'on est en mode PM
  currentPMUser = friendUsername;
  currentChannel = null;
  
  // Changer le titre du chat
  $('channel-name').textContent = `💬 ${friendUsername}`;
  
  // Charger l'historique MP
  try {
    const res = await fetch(SERVER_URL + '/load-pm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + myToken
      },
      body: JSON.stringify({ friendUsername })
    });
    
    const messages = await res.json();

    // Afficher la zone de saisie
    $('input-area').classList.remove('hidden');

    // Afficher les messages
    $('messages-area').innerHTML = '';
    messages.forEach(msg => {
      addPM(msg);
    });
    scrollBottom();

    // Réinitialiser les MP non lus de cet ami
    unreadPMs[friendUsername] = 0;
    updateFriendsBadge();

    // Mettre le focus sur l'input
    setTimeout(() => {
      $('msg-input').focus();
    }, 100);
    
  } catch (err) {
    console.error('Erreur chargement MP:', err);
  }
};

// Afficher un MP
function addPM(msg) {
  const div = document.createElement('div');
  div.className = 'message';
  div.setAttribute('data-msg-id', msg._id);
  
  const isMine = msg.from === myUsername;
  const displayName = isMine ? myUsername : msg.from;
  
  div.innerHTML = `
    <div class="msg-header">
      <span class="msg-username">${displayName}</span>
      <span class="msg-time">${new Date(msg.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
      ${isMine ? `
        <button class="msg-edit-btn" onclick="editPM('${msg._id}')">✏️</button>
        <button class="msg-delete-btn" onclick="deletePM('${msg._id}')">🗑️</button>
      ` : ''}
    </div>
    <div class="msg-body">
      <div class="msg-content">${formatLinks(formatMentions(escapeHtml(msg.content)))}${msg.edited ? ' <span class="msg-edited">(modifié)</span>' : ''}</div>
    </div>
  `;
  
  $('messages-area').appendChild(div);
}

// Éditer un MP
window.editPM = async (messageId) => {
  // Récupérer le contenu actuel
  const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
  const currentContent = msgEl.querySelector('.msg-content').textContent.replace(' (modifié)', '').trim();
  
  // Ouvrir le modal
  $('edit-pm-modal').classList.remove('hidden');
  $('edit-pm-input').value = currentContent;
  $('edit-pm-input').focus();
  
  // Gérer la sauvegarde
  $('save-pm-edit-btn').onclick = async () => {
    const newContent = $('edit-pm-input').value.trim();
    if (!newContent) return alert('Le message ne peut pas être vide');
    
    try {
      const res = await fetch(SERVER_URL + '/edit-pm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + myToken
        },
        body: JSON.stringify({ messageId, newContent })
      });
      
      if (res.ok) {
        // Mettre à jour localement
        const contentEl = msgEl.querySelector('.msg-content');
        contentEl.innerHTML = formatLinks(formatMentions(escapeHtml(newContent))) + ' <span class="msg-edited">(modifié)</span>';
        
        // Fermer le modal
        $('edit-pm-modal').classList.add('hidden');
        $('edit-pm-input').value = '';
      }
    } catch (err) {
      console.error(err);
      alert('Erreur lors de la modification');
    }
  };
};

// Supprimer un MP
window.deletePM = async (messageId) => {
  // Utiliser un modal au lieu de confirm() qui vole le focus dans Electron
  const modal = $('delete-pm-modal');
  const confirmBtn = $('delete-pm-confirm-btn');
  const cancelBtn = $('delete-pm-cancel-btn');

  modal.classList.remove('hidden');

  confirmBtn.onclick = async () => {
    modal.classList.add('hidden');

    try {
      const res = await fetch(SERVER_URL + '/delete-pm', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + myToken
        },
        body: JSON.stringify({ messageId })
      });

      if (res.ok) {
        const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
        if (msgEl) msgEl.remove();

        // Simple focus sans blur/window.focus()
        setTimeout(() => $('msg-input').focus(), 50);
      }
    } catch (err) {
      console.error(err);
    }
  };

  cancelBtn.onclick = () => {
    modal.classList.add('hidden');
    setTimeout(() => $('msg-input').focus(), 50);
  };
};

// PANEL ADMIN
let isAdmin = false;
let myRole = 'user';

async function checkAdmin() {
  try {
    const res = await fetch(SERVER_URL + '/is-admin', {
      headers: { 'Authorization': 'Bearer ' + myToken }
    });
    const data = await res.json();
    isAdmin = data.isAdmin;

    // Récupérer le rôle
    const userRes = await fetch(SERVER_URL + '/all-users');
    const users = await userRes.json();
    const me = users.find(u => u.username === myUsername);
    myRole = me?.role || 'user';

    // Tout le monde voit le bouton paramètres
    $('admin-btn').classList.remove('hidden');

    // Afficher boutons + si admin
    showAdminChannelButtons();

  } catch (err) {
    console.error('Erreur vérification admin:', err);
  }
}

function getRoleLabel(role) {
  const labels = {
    'admin': '👑 Admin',
    'moderator': '🛡️ Modérateur',
    'user': '👤 Utilisateur'
  };
  return labels[role] || labels['user'];
}

async function loadAdminUsers() {
  try {
    const res = await fetch(SERVER_URL + '/all-users');
    const users = await res.json();

    const listEl = $('admin-users-list');
    listEl.innerHTML = '';

    users.forEach(user => {
      const div = document.createElement('div');
      div.className = 'admin-user-item';

      const avatarUrl = user.avatar ? (user.avatar.startsWith('http') ? user.avatar : SERVER_URL + user.avatar) : null;

      div.innerHTML = `
  <div class="member-avatar">
    ${avatarUrl ? `<img src="${avatarUrl}" alt="${user.username}">` : user.username[0].toUpperCase()}
  </div>
  <div class="admin-user-info">
  <strong>${user.username}</strong>
  <span class="role-badge role-${user.role || 'user'}">${getRoleLabel(user.role || 'user')}</span>
  <select class="role-select" onchange="changeRole('${user.username}', this.value)">
    <option value="user" ${user.role === 'user' || !user.role ? 'selected' : ''}>Utilisateur</option>
    <option value="moderator" ${user.role === 'moderator' ? 'selected' : ''}>Modérateur</option>
    <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
  </select>
</div>
  <div class="admin-user-actions">
  ${user.username !== myUsername ? `<button class="admin-btn danger" onclick="deleteUser('${user.username}')">Supprimer</button>` : ''}
</div>
`;

      listEl.appendChild(div);
    });
  } catch (err) {
    console.error('Erreur chargement users:', err);
  }
}

window.deleteUser = async function (username) {
  if (!confirm(`Supprimer définitivement l'utilisateur "${username}" ?`)) return;

  try {
    const res = await fetch(SERVER_URL + '/admin/delete-user/' + username, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + myToken }
    });

    if (res.ok) {
      alert('Utilisateur supprimé !');
      loadAdminUsers();
    } else {
      alert('Erreur lors de la suppression');
    }
  } catch (err) {
    console.error('Erreur suppression:', err);
    alert('Erreur serveur');
  }
};

window.changeRole = async function (username, newRole) {
  try {
    const res = await fetch(SERVER_URL + '/admin/change-role', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + myToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username, role: newRole })
    });

    if (res.ok) {
      console.log(`Rôle de ${username} changé en ${newRole}`);
    } else {
      alert('Erreur lors du changement de rôle');
    }
  } catch (err) {
    console.error('Erreur changement rôle:', err);
    alert('Erreur serveur');
  }
};

// Réactions
window.toggleReactionPicker = function(messageId, event) {
  event.stopPropagation();
  
  // Fermer les autres pickers
document.querySelectorAll('.reaction-picker').forEach(p => p.remove());
  
  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  picker.innerHTML = `
  <button class="emoji-btn" onclick="addReaction('${messageId}', '👍')">👍</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '❤️')">❤️</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '😂')">😂</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '🔥')">🔥</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '👏')">👏</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '😊')">😊</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '🤩')">🤩</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '🤔')">🤔</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '😁')">😁</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '😅')">😅</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '🤣')">🤣</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '😱')">😱</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '👌')">👌</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '💩')">💩</button>
  <button class="emoji-btn" onclick="addReaction('${messageId}', '💪')">💪</button>
`;

  
  
  const btn = event.target;
  btn.parentElement.appendChild(picker);
  
  // Fermer au clic extérieur
  setTimeout(() => {
    document.addEventListener('click', function closePicker(e) {
      if (!picker.contains(e.target)) {
        picker.remove();
        document.removeEventListener('click', closePicker);
      }
    });
  }, 10);
};

window.addReaction = async function(messageId, emoji) {
  document.querySelectorAll('.reaction-picker').forEach(p => p.remove());
  
  try {
    await fetch(SERVER_URL + '/add-reaction', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + myToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messageId, emoji })
    });
  } catch (err) {
    console.error('Erreur ajout réaction:', err);
  }
};

window.toggleReaction = async function(messageId, emoji) {
  try {
    // Vérifier si l'utilisateur a déjà réagi avec cet emoji
    const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
    const reactionBtn = Array.from(msgEl.querySelectorAll('.reaction-btn')).find(btn => btn.textContent.trim().startsWith(emoji));
    
    // TODO: vérifier si mon nom est dans la liste des users
    // Pour l'instant on toggle toujours (ajouter si pas là, retirer sinon)
    
    await fetch(SERVER_URL + '/remove-reaction', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + myToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messageId, emoji })
    });
  } catch (err) {
    console.error('Erreur toggle réaction:', err);
  }
};

$('auth-password').onkeydown = e => { if (e.key === 'Enter') $('auth-submit').click(); };
$('logout-btn').onclick = () => { localStorage.clear(); location.reload(); };

// AUTO LOGIN
const savedToken = localStorage.getItem('token');
const savedUsername = localStorage.getItem('username');
const savedAvatar = localStorage.getItem('avatar');
if (savedToken && savedUsername) {
  myToken = savedToken;
  myUsername = savedUsername;
  myAvatar = (savedAvatar && savedAvatar !== 'null') ? savedAvatar : null;
  startApp();
}

// Paramètres audio globaux
let micGain = 1.0;
let outputGain = 1.0;
const savedMicVolume = localStorage.getItem('micVolume') || 100;
const savedOutputVolume = localStorage.getItem('outputVolume') || 100;
let noiseReductionEnabled = localStorage.getItem('noiseReduction') === 'true';

function startApp() {
  $('auth-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('my-username').textContent = myUsername;
  console.log('startApp - myAvatar avant updateMyAvatar:', myAvatar);
  updateMyAvatar();
  connectSocket();
  loadChannels();
  // Rejoindre automatiquement le salon vocal si on y était
const savedVoiceChannel = localStorage.getItem('currentVoiceChannel');
if (savedVoiceChannel) {
  try {
    const channel = JSON.parse(savedVoiceChannel);
    // Attendre un peu que tout soit chargé
    setTimeout(() => {
      joinVoiceChannel(channel);
    }, 1000);
  } catch (err) {
    console.error('Erreur rejoin vocal:', err);
  }
}
  checkAdmin();

 $('admin-btn').onclick = () => {
  $('admin-panel').classList.remove('hidden');
  
  // Initialiser les sliders audio
  $('mic-volume').value = savedMicVolume;
  $('output-volume').value = savedOutputVolume;
  $('mic-volume-value').textContent = savedMicVolume + '%';
  $('output-volume-value').textContent = savedOutputVolume + '%';

  // Initialiser le toggle réduction de bruit
$('noise-reduction').checked = noiseReductionEnabled;

 // Initialiser les autres toggles audio
$('audio-compressor').checked = compressorEnabled;
$('noise-gate').checked = noiseGateEnabled;
$('audio-equalizer').checked = equalizerEnabled;
  
  // Volume micro
  
  // Volume micro
  $('mic-volume').oninput = (e) => {
    const value = e.target.value;
    $('mic-volume-value').textContent = value + '%';
    micGain = value / 100;
    localStorage.setItem('micVolume', value);

    // Appliquer le gain réel via Web Audio API
  if (micGainNode) {
    micGainNode.gain.value = value / 100;
  }
    
    if (localStream) {
      localStream.getAudioTracks().forEach(track => {
        track.applyConstraints({ 
          advanced: [{ echoCancellation: true, noiseSuppression: true }]
        });
      });
    }
  };
  
  // Volume sortie
  $('output-volume').oninput = (e) => {
    const value = e.target.value;
    $('output-volume-value').textContent = value + '%';
    outputGain = value / 100;
    localStorage.setItem('outputVolume', value);
    
    document.querySelectorAll('.remote-audio').forEach(audio => {
      audio.volume = Math.min(outputGain, 1.0);
    });
  };

  // Réduction de bruit
$('noise-reduction').onchange = (e) => {
  noiseReductionEnabled = e.target.checked;
  localStorage.setItem('noiseReduction', noiseReductionEnabled);
  
  // Appliquer au stream local
  if (localStream) {
    localStream.getAudioTracks().forEach(track => {
      track.applyConstraints({
        echoCancellation: true,
        noiseSuppression: noiseReductionEnabled,
        autoGainControl: true
      });
    });
  }
};

// Compresseur audio
$('audio-compressor').onchange = (e) => {
  compressorEnabled = e.target.checked;
  localStorage.setItem('audioCompressor', compressorEnabled);
  alert('Relancez le salon vocal pour appliquer le compresseur.');
};

// Gate de bruit
$('noise-gate').onchange = (e) => {
  noiseGateEnabled = e.target.checked;
  localStorage.setItem('noiseGate', noiseGateEnabled);
  // Le gate s'applique en temps réel dans checkMyAudioLevel
};

// Égaliseur
$('audio-equalizer').onchange = (e) => {
  equalizerEnabled = e.target.checked;
  localStorage.setItem('audioEqualizer', equalizerEnabled);
  
  // Appliquer l'égaliseur en temps réel
  if (window.audioFilters && window.audioFilters.biquadFilter) {
    window.audioFilters.biquadFilter.gain.value = equalizerEnabled ? 6 : 0; // +6dB boost aigus
  }
};
  
  // Afficher/cacher sections admin
  if (isAdmin) {
    $('admin-users-section').style.display = 'block';
    $('admin-messages-section').style.display = 'block';
    loadAdminUsers();
  } else {
    $('admin-users-section').style.display = 'none';
    $('admin-messages-section').style.display = 'none';
  }

  $('admin-close-btn').onclick = () => {
    $('admin-panel').classList.add('hidden');
  };
};


  // Définir les fonctions d'édition/suppression
  window.editMessage = function (messageId) {
    const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
    if (!msgEl) return;

    const contentEl = msgEl.querySelector('.msg-content');
    if (!contentEl) return;

    const currentText = contentEl.textContent;

    // Ouvrir le modal
    const modal = $('edit-modal');
    const textarea = $('edit-textarea');
    const saveBtn = $('edit-save-btn');
    const cancelBtn = $('edit-cancel-btn');

    textarea.value = currentText;
    modal.classList.remove('hidden');
    textarea.focus();

    // Sauvegarder
    saveBtn.onclick = () => {
      const newText = textarea.value.trim();
      if (newText && newText !== currentText) {
        socket.emit('edit_message', { messageId, newContent: newText });
      }
      modal.classList.add('hidden');
    };

    // Annuler
    cancelBtn.onclick = () => {
      modal.classList.add('hidden');
    };
  };  // ← Ferme editMessage

  window.deleteMessage = function (messageId, isAdminDelete = false) {
    const modal = $('delete-modal');
    const confirmBtn = $('delete-confirm-btn');
    const cancelBtn = $('delete-cancel-btn');

    modal.classList.remove('hidden');

    confirmBtn.onclick = () => {
      if (isAdminDelete) {
        // Suppression admin via route spéciale
        fetch(SERVER_URL + '/admin/delete-message/' + messageId, {
          method: 'DELETE',
          headers: { 'Authorization': 'Bearer ' + myToken }
        }).then(res => {
          if (res.ok) {
            socket.emit('message_deleted', { messageId });
          }
        });
      } else {
        // Suppression normale
        socket.emit('delete_message', { messageId });
      }
      modal.classList.add('hidden');
      setTimeout(() => {
        const input = $('msg-input');
        if (input) input.focus();
      }, 100);
    };

    cancelBtn.onclick = () => {
      modal.classList.add('hidden');
      setTimeout(() => {
        const input = $('msg-input');
        if (input) input.focus();
      }, 100);
    };
  };  // ← Ferme deleteMessage
}  // ← Ferme startApp()

// Changement d'avatar
$('change-avatar-btn').onclick = () => {
  $('avatar-input').click();
};

$('avatar-input').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // Vérifier la taille (max 5MB)
  if (file.size > 5 * 1024 * 1024) {
    alert('L\'image est trop grosse (max 5MB)');
    return;
  }

  const formData = new FormData();
  formData.append('avatar', file);

  try {
    const res = await fetch(SERVER_URL + '/upload-avatar', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + myToken },
      body: formData
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Erreur upload');
      return;
    }

    // Mettre à jour l'avatar localement
    myAvatar = data.avatar;
    localStorage.setItem('avatar', myAvatar);
    updateMyAvatar();
  } catch (err) {
    console.error('Erreur upload avatar:', err);
    alert('Impossible d\'uploader l\'image');
  }
};

function updateMyAvatar() {
  console.log('updateMyAvatar appelé, myAvatar =', myAvatar, typeof myAvatar);
  const avatarEl = $('my-avatar');
  if (myAvatar && myAvatar !== 'null') {
    // Si c'est une URL Cloudinary (commence par http), l'utiliser directement
    const avatarUrl = myAvatar.startsWith('http') ? myAvatar : SERVER_URL + myAvatar;
    avatarEl.innerHTML = `<img src="${avatarUrl}" alt="Avatar">`;
  } else {
    avatarEl.textContent = myUsername[0].toUpperCase();
  }
}

// SOCKET
function connectSocket() {
  socket = io(SERVER_URL, { auth: { token: myToken } });
  socket.on('new_message', (msg) => {
    console.log('Message reçu:', msg);

    // Écouter les modifications de messages
    socket.on('message_edited', ({ messageId, content, edited }) => {
      const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
      if (!msgEl) return;

      const contentEl = msgEl.querySelector('.msg-content');
      const timeEl = msgEl.querySelector('.msg-time');

      if (contentEl) contentEl.textContent = content;
      if (timeEl && edited && !msgEl.querySelector('.msg-edited')) {
        timeEl.insertAdjacentHTML('afterend', '<span class="msg-edited">(modifié)</span>');
      }
    });

    // Écouter les suppressions de messages
    socket.on('message_deleted', ({ messageId }) => {
      const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
      if (msgEl) {
        msgEl.remove();
        // Forcer le focus sur l'input après suppression
        setTimeout(() => {
          const input = $('msg-input');
          if (input) input.focus();
        }, 50);
      }
    });

    // Si le message vient d'un autre salon, incrémenter le compteur
    if (msg.channelId && msg.channelId !== currentChannel && msg.username !== myUsername) {
      console.log('Notification pour salon:', msg.channelId, 'currentChannel:', currentChannel);
      unreadCounts[msg.channelId] = (unreadCounts[msg.channelId] || 0) + 1;
      updateChannelBadges();
      notificationSound.play().catch(() => { });
    }
    // Afficher le message SEULEMENT si c'est le bon salon
    if (msg.channelId === currentChannel) {
      addMessage(msg);
    }
  });

// Recevoir un MP
  socket.on('pm_received', (msg) => {
  console.log('📬 PM reçu:', msg);
  
  if (currentPMUser === msg.from) {
    addPM(msg);
    scrollBottom();
  } else {
    // 🔴 Badge MP non lus
    unreadPMs[msg.from] = (unreadPMs[msg.from] || 0) + 1;
    updateFriendsBadge();
    
    // 🔔 Son de notification
    notificationSound.play().catch(() => {});
  }
});

  socket.on('channel_history', msgs => { $('messages-area').innerHTML = ''; msgs.forEach(addMessage); scrollBottom(); });
  socket.on('online_users', async (usersFromServer) => {
  // Stocker les users en ligne globalement
  onlineUsers = {};
  usersFromServer.forEach(u => {
    onlineUsers[u.username] = u;
  });
  
  // Récupérer tous les utilisateurs depuis le serveur
  const res = await fetch(SERVER_URL + '/all-users');
  const allUsers = await res.json();

    // Séparer en ligne / hors ligne
    const onlineUsernames = usersFromServer.map(u => u.username);
    const online = allUsers.filter(u => onlineUsernames.includes(u.username));
    const offline = allUsers.filter(u => !onlineUsernames.includes(u.username));

    // Afficher
    $('members-list').innerHTML = '';

    // Section EN LIGNE
    if (online.length > 0) {
      const onlineTitle = document.createElement('div');
      onlineTitle.className = 'members-section-title';
      onlineTitle.textContent = `EN LIGNE (${online.length})`;
      $('members-list').appendChild(onlineTitle);

      online.forEach(user => {
        const el = document.createElement('div');
        el.className = 'member-item';
        const avatarUrl = user.avatar ? (user.avatar.startsWith('http') ? user.avatar : SERVER_URL + user.avatar) : null;
       el.innerHTML = `
        <div class="member-avatar" style="position: relative;">
          ${avatarUrl ? `<img src="${avatarUrl}" alt="${user.username}">` : user.username[0].toUpperCase()}
          <div style="position: absolute; bottom: 0; right: 0; width: 13px; height: 13px; background: var(--green); border-radius: 50%; border: 2px solid var(--bg1);"></div>
        </div>
        <span class="username-role role-${user.role || 'user'}">${user.username}</span>
      `;
      el.onclick = () => openUserProfile(user);
      $('members-list').appendChild(el);
      });
    }

    // Section HORS LIGNE
    if (offline.length > 0) {
      const offlineTitle = document.createElement('div');
      offlineTitle.className = 'members-section-title offline-title';
      offlineTitle.textContent = `HORS LIGNE (${offline.length})`;
      $('members-list').appendChild(offlineTitle);

      offline.forEach(user => {
        const el = document.createElement('div');
        el.className = 'member-item offline';
        const avatarUrl = user.avatar ? (user.avatar.startsWith('http') ? user.avatar : SERVER_URL + user.avatar) : null;
        el.innerHTML = `
        <div class="member-avatar" style="position: relative;">
          ${avatarUrl ? `<img src="${avatarUrl}" alt="${user.username}">` : user.username[0].toUpperCase()}
          <div style="position: absolute; bottom: 0; right: 0; width: 13px; height: 13px; background: var(--t2); border-radius: 50%; border: 2px solid var(--bg1);"></div>
        </div>
        <span>${user.username}</span>
      `;
      el.onclick = () => openUserProfile(user);
        $('members-list').appendChild(el);
      });
    }
  });

  socket.on('voice_rooms_state', updateVoiceRooms);
  socket.on('voice_peers', async list => { for (const { peerId, username } of list) await createPeer(peerId, true, username); });
  socket.on('peer_joined', async ({ peerId, username, avatar }) => {
    await createPeer(peerId, false, username);
    joinSound.play().catch(() => { });
  });
  socket.on('signal', ({ from, signal }) => { if (peers[from]) peers[from].peer.signal(signal); });
  socket.on('peer_left', ({ peerId }) => {
    if (peers[peerId]) { peers[peerId].peer.destroy(); delete peers[peerId]; }
    const box = document.getElementById('stream-' + peerId);
    if (box) box.remove();
    leaveSound.play().catch(() => { });
  });

// Écouter création/suppression salon en temps réel
socket.on('channel_created', (channel) => {
  addChannelToSidebar(channel);
});

socket.on('channel_deleted', ({ channelId }) => {
  const el = document.getElementById('ch-' + channelId);
  if (el) {
    const sub = el.nextElementSibling;
    if (sub && sub.classList.contains('channel-voice-users')) sub.remove();
    el.remove();
  }
});

  socket.on('reaction_updated', ({ messageId, reactions }) => {
  const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!msgEl) return;
  
  const msgBody = msgEl.querySelector('.msg-body');
  
  // Supprimer l'ancien bloc de réactions s'il existe
  const oldReactions = msgBody.querySelector('.msg-reactions');
  if (oldReactions) oldReactions.remove();
  
  // Ajouter les nouvelles réactions
  if (reactions && reactions.length > 0) {
    const reactionsDiv = document.createElement('div');
    reactionsDiv.className = 'msg-reactions';
    reactionsDiv.innerHTML = reactions.map(r => `
      <button class="reaction-btn" onclick="toggleReaction('${messageId}', '${r.emoji}')">
        ${r.emoji} <span class="reaction-count">${r.users.length}</span>
      </button>
    `).join('');
    
    msgBody.appendChild(reactionsDiv);
  }
});

socket.on('user_streaming_update', ({ username, streaming }) => {
  updateStreamIndicator(username, streaming);
});
// Keep-alive ping
setInterval(() => {
  if (socket && socket.connected) {
    socket.emit('ping');
  }
}, 30000); // Toutes les 30 secondes

socket.on('pong', () => {
  // Le serveur a bien répondu, connexion active
});
// Recevoir ordre de déplacement (admin)
socket.on('force_move_voice', async ({ fromChannelId, toChannelId }) => {
  console.log(`🔀 Déplacement forcé vers: ${toChannelId}`);
  
  // Quitter le salon actuel
  if (fromChannelId) {
    await leaveVoice();
  }
  
  // Rejoindre le nouveau salon
  const channels = await fetch(SERVER_URL + '/channels').then(r => r.json());
  const allChannels = [...channels.voice];
  const targetChannel = allChannels.find(ch => ch.id === toChannelId);
  
  if (targetChannel) {
    setTimeout(() => joinVoiceChannel(targetChannel), 500);
  }
});

// Rejoin automatique si socket se reconnecte
socket.on('reconnect', () => {
  console.log('🔄 Socket reconnecté');
  if (currentVoiceChannel) {
    const savedVoiceChannel = localStorage.getItem('currentVoiceChannel');
    if (savedVoiceChannel) {
      try {
        const channel = JSON.parse(savedVoiceChannel);
        setTimeout(() => joinVoiceChannel(channel), 1000);
      } catch (err) {
        console.error('Erreur rejoin:', err);
      }
    }
  }
});
}


// CHANNELS
async function loadChannels(retries = 3) {
  try {
    const res = await fetch(SERVER_URL + '/channels');
    if (!res.ok) throw new Error('Erreur serveur');
    
    const data = await res.json();
    $('text-channels').innerHTML = '';
    $('voice-channels').innerHTML = '';
    
    data.text.forEach(ch => addChannelToSidebar(ch));
    data.voice.forEach(ch => addChannelToSidebar(ch));

    // Afficher boutons admin
    showAdminChannelButtons();

  } catch (err) {
    console.error('Erreur chargement salons:', err);
    if (retries > 0) {
      console.log(`Nouvelle tentative dans 2 secondes... (${retries} restantes)`);
      setTimeout(() => loadChannels(retries - 1), 2000);
    } else {
      alert('Impossible de charger les salons. Le serveur est peut-être en cours de démarrage. Actualisez la page dans quelques secondes.');
    }
  }
}

function addChannelToSidebar(channel) {
  const el = document.createElement('div');
  el.className = 'channel-item';
  el.id = 'ch-' + channel.id;

  if (channel.type === 'text') {
    el.innerHTML = `<span style="color:var(--t3);font-size:16px">#</span>${channel.name}`;
    el.onclick = () => joinTextChannel(channel);
    if (isAdmin) {
      const delBtn = document.createElement('button');
      delBtn.className = 'delete-channel-btn';
      delBtn.textContent = '🗑️';
      delBtn.title = 'Supprimer le salon';
      delBtn.onclick = (e) => { e.stopPropagation(); deleteChannel(channel.id); };
      el.appendChild(delBtn);
    }
    $('text-channels').appendChild(el);
  } else {
    el.innerHTML = channel.name;
    el.onclick = () => joinVoiceChannel(channel);
    if (isAdmin) {
      const delBtn = document.createElement('button');
      delBtn.className = 'delete-channel-btn';
      delBtn.textContent = '🗑️';
      delBtn.title = 'Supprimer le salon';
      delBtn.onclick = (e) => { e.stopPropagation(); deleteChannel(channel.id); };
      el.appendChild(delBtn);
    }
    $('voice-channels').appendChild(el);
  }
}

function showAdminChannelButtons() {
  if (isAdmin) {
    $('add-text-channel-btn').classList.remove('hidden');
    $('add-voice-channel-btn').classList.remove('hidden');
    
    // ✅ Assigner les onclick ici
    $('add-text-channel-btn').onclick = () => openCreateChannelModal('text');
    $('add-voice-channel-btn').onclick = () => openCreateChannelModal('voice');
  }
}

function openCreateChannelModal(type) {
  const modal = $('create-channel-modal');
  $('create-channel-title').textContent = type === 'text' ? '➕ Créer un salon textuel' : '➕ Créer un salon vocal';
  $('create-channel-name').value = '';
  modal.classList.remove('hidden');
  $('create-channel-name').focus();

  $('create-channel-confirm-btn').onclick = async () => {
    const name = $('create-channel-name').value.trim();
    if (!name) return;
    const res = await fetch(SERVER_URL + '/admin/create-channel', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + myToken
      },
      body: JSON.stringify({ name, type })
    });
    if (res.ok) modal.classList.add('hidden');
  };

  $('create-channel-cancel-btn').onclick = () => modal.classList.add('hidden');
}

async function deleteChannel(channelId) {
  const modal = $('delete-modal');
  const confirmBtn = $('delete-confirm-btn');
  const cancelBtn = $('delete-cancel-btn');

  modal.classList.remove('hidden');

  confirmBtn.onclick = async () => {
    modal.classList.add('hidden');
    await fetch(SERVER_URL + '/admin/delete-channel/' + channelId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + myToken }
    });
  };

  cancelBtn.onclick = () => modal.classList.add('hidden');
}

function updateVoiceRooms(state) {
  // ✅ Nettoyer TOUS les channel-voice-users d'abord
  document.querySelectorAll('.channel-voice-users').forEach(el => el.remove());

  // Reconstruire uniquement les salons avec des utilisateurs
  Object.entries(state).forEach(([cId, usersList]) => {
    const el = document.getElementById('ch-' + cId);
    if (!el) return;

    if (usersList.length > 0) {
      const container = document.createElement('div');
      container.className = 'channel-voice-users';
      
      usersList.forEach(u => {
        const userDiv = document.createElement('div');
        userDiv.className = 'voice-user-item-sidebar';
        const avatarUrl = u.avatar ? (u.avatar.startsWith('http') ? u.avatar : SERVER_URL + u.avatar) : null;
        userDiv.innerHTML = `
          <div class="voice-user-avatar-small">
            ${avatarUrl ? `<img src="${avatarUrl}" alt="${u.username}">` : (u.username || 'U')[0].toUpperCase()}
          </div>
          <span class="voice-user-name">${u.username || 'Utilisateur'}</span>
        `;

        // Menu clic droit admin only
        if (isAdmin && u.username !== myUsername) {
          userDiv.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showMoveUserMenu(e, u.username);
          });
        }

        container.appendChild(userDiv);
      });
      
      el.after(container);
    }

    // Mettre à jour la barre vocale du bas
    if (cId === currentVoiceChannel) {
      const usersEl = $('voice-bar-users');
      usersEl.innerHTML = '';

      const myUserDiv = document.createElement('div');
      myUserDiv.className = 'voice-user-item';
      myUserDiv.innerHTML = `
        <div class="voice-user-avatar">
          ${myAvatar ? `<img src="${myAvatar.startsWith('http') ? myAvatar : SERVER_URL + myAvatar}" alt="${myUsername}">` : myUsername[0].toUpperCase()}
        </div>
        <span>${myUsername}</span>
      `;
      usersEl.appendChild(myUserDiv);

      usersList.forEach(user => {
        const peerEntry = Object.entries(peers).find(([id, data]) => data.username === (user.username || user));
        if (!peerEntry) return;

        const [peerId, peerData] = peerEntry;
        const userDiv = document.createElement('div');
        userDiv.className = 'voice-user-item';
        userDiv.id = 'voice-user-' + peerId;

        const username = user.username || user;
        const avatar = user.avatar;

        userDiv.innerHTML = `
          <div class="voice-user-avatar">
            ${avatar ? `<img src="${avatar.startsWith('http') ? avatar : SERVER_URL + avatar}" alt="${username}">` : username[0].toUpperCase()}
          </div>
          <span>${username}</span>
          <button class="voice-user-volume-btn" onclick="toggleVolumePopup('${peerId}', event)">🔊</button>
        `;
        usersEl.appendChild(userDiv);
      });
    }
  });

  // Réappliquer les boutons rouges pour les streamers
  streamingUsers.forEach(username => {
    document.querySelectorAll('.voice-user-item-sidebar').forEach(item => {
      if (item.textContent.includes(username) && !item.querySelector('.stream-indicator-btn')) {
        const streamBtn = document.createElement('button');
        streamBtn.className = 'stream-indicator-btn';
        streamBtn.textContent = '🔴';
        streamBtn.title = 'Voir le stream';
        streamBtn.onclick = () => toggleStreamWindow(username);
        item.appendChild(streamBtn);
      }
    });
 });
}

async function showMoveUserMenu(event, targetUsername) {
  // Supprimer menu existant
  document.querySelectorAll('.move-user-menu').forEach(m => m.remove());

  // Récupérer les salons vocaux
  const data = await fetch(SERVER_URL + '/channels').then(r => r.json());
  
  const menu = document.createElement('div');
  menu.className = 'move-user-menu';
  menu.innerHTML = `<div class="move-user-menu-title">🔀 Déplacer vers...</div>`;

  data.voice.forEach(ch => {
    const item = document.createElement('div');
    item.className = 'move-user-menu-item';
    item.textContent = ch.name;
    item.onclick = () => {
      socket.emit('move_user_to_voice', { targetUsername, targetChannelId: ch.id });
      menu.remove();
    };
    menu.appendChild(item);
  });

  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
  document.body.appendChild(menu);

  setTimeout(() => {
    document.addEventListener('click', function closeMenu(e) {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener('click', closeMenu);
      }
    });
  }, 10);
}

// Rafraîchissement automatique des salons vocaux toutes les 30 secondes
setInterval(() => {
  if (socket && socket.connected) {
    socket.emit('request_voice_rooms_state');
  }
}, 30000);

// Gestion des volumes individuels
let userVolumes = {}; // { peerId: volume (0-200) }

// Charger les volumes sauvegardés
const savedVolumes = localStorage.getItem('userVolumes');
if (savedVolumes) {
  userVolumes = JSON.parse(savedVolumes);
}

// Stocker les GainNodes pour chaque peer

function applyVolume(peerId, volume) {
  const audio = window.peerAudioElements && window.peerAudioElements[peerId];
  if (audio) {
    if (volume === 0) {
      audio.muted = true;
    } else {
      audio.muted = false;
      audio.volume = Math.min(volume / 100, 1.0);
    }
  }
  userVolumes[peerId] = volume;
  localStorage.setItem('userVolumes', JSON.stringify(userVolumes));
}

function toggleVolumePopup(peerId, event) {
  event.stopPropagation();
  
  // Supprimer les popups existants
  document.querySelectorAll('.volume-popup').forEach(p => p.remove());
  
  const popup = document.createElement('div');
  popup.className = 'volume-popup';
  popup.innerHTML = `
    <label>Volume: <span id="volume-value-${peerId}">100</span>%</label>
    <input type="range" id="volume-slider-${peerId}" min="0" max="200" value="${userVolumes[peerId] !== undefined ? userVolumes[peerId] : 100}">
  `;
  
  const btn = event.target;
  btn.parentElement.appendChild(popup);
  
  const slider = document.getElementById(`volume-slider-${peerId}`);
  const valueDisplay = document.getElementById(`volume-value-${peerId}`);
  
  // Afficher la valeur actuelle
  valueDisplay.textContent = userVolumes[peerId] !== undefined ? userVolumes[peerId] : 100;
  
  slider.oninput = (e) => {
    const volume = parseInt(e.target.value);
    valueDisplay.textContent = volume;
    userVolumes[peerId] = volume;
    applyVolume(peerId, volume);
  };
  
  // Fermer au clic extérieur
  setTimeout(() => {
    document.addEventListener('click', function closePopup(e) {
      if (!popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', closePopup);
      }
    });
  }, 100);
}

function openUserProfile(user) {
  const modal = $('user-profile-modal');
  
  // Remplir les infos
  $('profile-username').textContent = user.username;
  
  // Avatar
  const avatarEl = $('profile-avatar');
  const avatarUrl = user.avatar ? (user.avatar.startsWith('http') ? user.avatar : SERVER_URL + user.avatar) : null;
  if (avatarUrl) {
    avatarEl.innerHTML = `<img src="${avatarUrl}" alt="${user.username}">`;
  } else {
    avatarEl.textContent = user.username[0].toUpperCase();
  }
  
  // Rôle avec badge coloré
  const roleText = user.role === 'admin' ? '👑 Administrateur' : 
                   user.role === 'moderator' ? '🛡️ Modérateur' : 
                   '👤 Utilisateur';
  $('profile-role').textContent = roleText;
  $('profile-role').className = `role-${user.role || 'user'}`;
  
  // Bio
  $('profile-bio').value = user.bio || 'Aucune bio';
  
  // Date d'inscription
  const createdDate = user.createdAt ? new Date(user.createdAt).toLocaleDateString('fr-FR') : 'Inconnue';
  $('profile-created').textContent = createdDate;
  
  // Bouton modifier (visible seulement si c'est ton profil)
  const editBtn = $('profile-edit-btn');
  if (user.username === myUsername) {
    editBtn.classList.remove('hidden');
    editBtn.onclick = () => enableProfileEdit();
  } else {
    editBtn.classList.add('hidden');
  }
  
  // Ouvrir le modal
  modal.classList.remove('hidden');
}

function enableProfileEdit() {
  const bioField = $('profile-bio');
  const editBtn = $('profile-edit-btn');
  
  // Rendre le champ éditable
  bioField.readOnly = false;
  bioField.focus();
  
  // Changer le bouton en "Sauvegarder"
  editBtn.textContent = 'Sauvegarder';
  editBtn.onclick = () => saveProfileBio(bioField.value);
}

async function saveProfileBio(newBio) {
  try {
    const res = await fetch(SERVER_URL + '/update-bio', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + myToken
      },
      body: JSON.stringify({ bio: newBio })
    });
    
 if (res.ok) {
  alert('Bio mise à jour !');
  $('user-profile-modal').classList.add('hidden');
  // Remettre en lecture seule
  $('profile-bio').readOnly = true;
  $('profile-edit-btn').textContent = 'Modifier mon profil';
} else {
      alert('Erreur lors de la sauvegarde');
    }
  } catch (err) {
    console.error('Erreur sauvegarde bio:', err);
    alert('Erreur lors de la sauvegarde');
  }
}



// TEXT CHANNEL
function joinTextChannel(ch) {
  // Réinitialiser le compteur de ce salon
  unreadCounts[ch.id] = 0;
  updateChannelBadges();
  document.querySelectorAll('.channel-item').forEach(e => e.classList.remove('active'));
  document.getElementById('ch-' + ch.id)?.classList.add('active');
  currentChannel = ch.id;
  currentPMUser = null;
  $('channel-name').textContent = ch.name;
  $('input-area').classList.remove('hidden');
  $('messages-area').innerHTML = '';
  socket.emit('join_channel', ch.id);
}

function formatMessageDate(timestamp) {
  const msgDate = new Date(timestamp);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const time = msgDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

  // Même jour
  if (msgDate.toDateString() === now.toDateString()) {
    return `Aujourd'hui à ${time}`;
  }

  // Hier
  if (msgDate.toDateString() === yesterday.toDateString()) {
    return `Hier à ${time}`;
  }

  // Plus vieux : afficher la date
  const day = msgDate.getDate();
  const month = msgDate.toLocaleDateString('fr-FR', { month: 'long' });
  return `${day} ${month} à ${time}`;
}

function formatMentions(text) {
  // Remplacer @username par un span coloré
  return text.replace(/@(\w+)/g, '<span class="mention">@$1</span>');
}

function formatLinks(text) {
  // Regex pour détecter les URLs
  const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)/gi;
  
  return text.replace(urlRegex, (url) => {
    // Ajouter https:// si c'est juste www.
    const fullUrl = url.startsWith('www.') ? 'https://' + url : url;
    return `<a href="#" class="chat-link" data-url="${fullUrl}">${url}</a>`;
  });
}

// Ouvrir les liens dans le navigateur externe
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('chat-link')) {
    e.preventDefault();
    const url = e.target.getAttribute('data-url');
    if (window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }
});

async function fetchLinkPreview(url, container) {
  try {
    const res = await fetch(`${SERVER_URL}/fetch-preview?url=${encodeURIComponent(url)}`);
    if (!res.ok) return;
    
    const data = await res.json();
    if (!data.title && !data.image) return;

    const preview = document.createElement('div');
    preview.className = 'link-preview';
    preview.onclick = () => {
      if (window.electronAPI) window.electronAPI.openExternal(url);
      else window.open(url, '_blank');
    };

    preview.innerHTML = `
      ${data.image ? `<img class="link-preview-image" src="${data.image}" onerror="this.style.display='none'">` : ''}
      <div class="link-preview-content">
        ${data.siteName ? `<div class="link-preview-site">${data.siteName}</div>` : ''}
        ${data.title ? `<div class="link-preview-title">${data.title}</div>` : ''}
        ${data.description ? `<div class="link-preview-desc">${data.description}</div>` : ''}
      </div>
    `;

    container.appendChild(preview);
  } catch (err) {
    console.error('Erreur preview:', err);
  }
}

function downloadFile(url, filename) {
  fetch(url)
    .then(response => response.blob())
    .then(blob => {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = filename || 'fichier';
      link.click();
      URL.revokeObjectURL(link.href);
    })
    .catch(err => console.error('Erreur téléchargement:', err));
}

window.downloadFile = downloadFile;

// MESSAGES
function addMessage(msg) {

  const div = document.createElement('div');
  div.className = 'message';
  div.setAttribute('data-msg-id', msg._id);
  if (msg.content && msg.content.includes('@' + myUsername)) {
  div.classList.add('mentioned-me');
}
  let content = '';
  if (msg.type === 'image') {
  const imageUrl = msg.fileUrl.startsWith('http') ? msg.fileUrl : SERVER_URL + msg.fileUrl;
  content = `
    <div class="msg-file-container">
      <img class="msg-image" src="${imageUrl}" onclick="window.open('${imageUrl}')" />
     <button class="file-download-btn" onclick="downloadFile('${imageUrl}')" title="Télécharger">📥</button>
    </div>
  `;
} else if (msg.type === 'file') {
  const fileUrl = msg.fileUrl.startsWith('http') ? msg.fileUrl : SERVER_URL + msg.fileUrl;
  content = `
    <div class="msg-file-container">
      <a class="msg-file" href="${fileUrl}" target="_blank">📎 ${msg.fileName}</a>
     <button class="file-download-btn" onclick="downloadFile('${fileUrl}', '${msg.fileName}')" title="Télécharger">📥</button>
    </div>
  `;

} else {
    // Message de bienvenue bot
    if (msg.type === 'welcome' && msg.content.startsWith('WELCOME_CARD:')) {
      const parts = msg.content.split(':');
      const welcomeUsername = parts[1];
      const welcomeAvatar = parts[2] || '';
      const avatarContent = welcomeAvatar
        ? `<img src="${welcomeAvatar}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;">`
        : `<div style="width:56px;height:56px;border-radius:50%;background:#378ADD;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:600;color:#E6F1FB;">${welcomeUsername[0].toUpperCase()}</div>`;

      content = `
  <div style="display:flex;flex-direction:column;align-items:center;padding:24px 32px;background:#1e1f22;border:2px solid #378ADD;border-radius:16px;gap:10px;width:280px;margin:0 auto;">
    <div style="width:80px;height:80px;border-radius:50%;border:3px solid #fff;overflow:hidden;display:flex;align-items:center;justify-content:center;background:#378ADD;">
      ${welcomeAvatar
        ? `<img src="${welcomeAvatar}" style="width:100%;height:100%;object-fit:cover;">`
        : `<span style="font-size:28px;font-weight:600;color:#fff;">${welcomeUsername[0].toUpperCase()}</span>`}
    </div>
    <span style="font-size:15px;color:#fff;font-weight:500;text-align:center;">${escapeHtml(welcomeUsername)} rejoint ChatView !</span>
  </div>
`;
    // Détection auto des URLs d'images/GIFs
    } else if (msg.content && (msg.content.includes('.gif') || msg.content.includes('tenor.com') || msg.content.includes('.jpg') || msg.content.includes('.png'))) {
      content = `<img class="msg-image" src="${msg.content}" onclick="window.open('${msg.content}')" />`;
    } else {
      content = `<div class="msg-content" data-raw-content="${escapeHtml(msg.content)}">${formatLinks(formatMentions(escapeHtml(msg.content)))}</div>`;
    }
  }
  const isOwnMessage = msg.username === myUsername;
  const editedLabel = msg.edited ? '<span class="msg-edited">(modifié)</span>' : '';

  div.innerHTML = `
  <div class="msg-avatar">
    ${msg.avatar ? `<img src="${msg.avatar.startsWith('http') ? msg.avatar : SERVER_URL + msg.avatar}" alt="${msg.username}">` : msg.username[0].toUpperCase()}
  </div>
  <div class="msg-body">
    <div class="msg-header">
      <span class="msg-username role-${msg.role || 'user'}">${escapeHtml(msg.username)}</span>
      <span class="msg-time">${formatMessageDate(msg.timestamp)}</span>${editedLabel}
    </div>
    ${content}
    ${msg.reactions && msg.reactions.length > 0 ? `
  <div class="msg-reactions">
    ${msg.reactions.map(r => `
      <button class="reaction-btn" onclick="toggleReaction('${msg._id}', '${r.emoji}')">
        ${r.emoji} <span class="reaction-count">${r.users.length}</span>
      </button>
    `).join('')}
  </div>
` : ''}
  </div>
  ${(isOwnMessage || isAdmin || myRole === 'moderator') ? `
  <div class="msg-actions">
    <button class="msg-action-btn" onclick="toggleReactionPicker('${msg._id}', event)" title="Réagir">➕</button>
    ${isOwnMessage ? `<button class="msg-action-btn" onmousedown="event.preventDefault()" onclick="editMessage('${msg._id}')">✏️</button>` : ''}
    <button class="msg-action-btn" onmousedown="event.preventDefault()" onclick="deleteMessage('${msg._id}', ${isAdmin || myRole === 'moderator'})">🗑️</button>
  </div>
` : `
  <div class="msg-actions">
    <button class="msg-action-btn" onclick="toggleReactionPicker('${msg._id}', event)" title="Réagir">➕</button>
  </div>
`}
`;
  $('messages-area').appendChild(div);
  scrollBottom();

  // Générer preview si lien détecté
  if (msg.content) {
    const urlRegex = /(https?:\/\/[^\s]+)/gi;
    const urls = msg.content.match(urlRegex);
    if (urls && urls.length > 0) {
      const msgBody = div.querySelector('.msg-body');
      if (msgBody) fetchLinkPreview(urls[0], msgBody);
    }
  }

  // Détecter si je suis mentionné
if (msg.content && msg.content.includes('@' + myUsername) && msg.username !== myUsername) {
  mentionSound.play().catch(() => {});
  
  // Badge rouge si message pas dans le salon actuel
  if (msg.channelId !== currentChannel) {
    unreadCounts[msg.channelId] = (unreadCounts[msg.channelId] || 0) + 1;
    updateChannelBadges();
  }
}
}

function scrollBottom() { $('messages-area').scrollTop = $('messages-area').scrollHeight; }

$('send-btn').onclick = sendMessage;
$('msg-input').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } };

function sendMessage() {
  const content = $('msg-input').value.trim();
  if (!content) return;
  
  // Si en mode PM
  if (currentPMUser) {
    fetch(SERVER_URL + '/send-pm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + myToken
      },
      body: JSON.stringify({ to: currentPMUser, content })
    })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        console.log('Message envoyé:', data.message); // ← Ajouter
        addPM(data.message);
        scrollBottom();
        socket.emit('pm_sent', { to: currentPMUser, message: data.message }); // Notifier l'autre user
      }
    })
    .catch(err => console.error(err));
    
    $('msg-input').value = '';
    return;
  }
  
  // Sinon mode salon normal
  if (!currentChannel) return;
  socket.emit('send_message', { channelId: currentChannel, content, type: 'text' });
  $('msg-input').value = '';
}

// Autocomplete mentions
let mentionIndex = -1;
let filteredUsers = [];


$('msg-input').addEventListener('input', (e) => {
// Ne rien faire si pas dans un salon ou MP
  if (!currentChannel && !currentPMUser) return;

  const text = e.target.value;
  const cursorPos = e.target.selectionStart;
  
  // Chercher si on tape @ suivi de lettres
  const beforeCursor = text.substring(0, cursorPos);
  const match = beforeCursor.match(/@(\w*)$/);
  
  if (match) {
    const query = match[1].toLowerCase();
    
    // Filtrer les utilisateurs en ligne
    filteredUsers = Object.values(onlineUsers)
      .filter(u => u.username.toLowerCase().startsWith(query))
      .slice(0, 5);
    
    if (filteredUsers.length > 0) {
      showMentionAutocomplete(filteredUsers);
      mentionIndex = 0;
    } else {
      hideMentionAutocomplete();
    }
  } else {
    hideMentionAutocomplete();
  }
});


function showMentionAutocomplete(users) {
  const autocomplete = $('mention-autocomplete');
  autocomplete.innerHTML = '';
  autocomplete.classList.remove('hidden');
  
  users.forEach((user, index) => {
    const div = document.createElement('div');
    div.className = 'mention-suggestion' + (index === mentionIndex ? ' selected' : '');
    
    const avatarUrl = user.avatar ? (user.avatar.startsWith('http') ? user.avatar : SERVER_URL + user.avatar) : null;
    
    div.innerHTML = `
      <div class="member-avatar">
        ${avatarUrl ? `<img src="${avatarUrl}" alt="${user.username}">` : user.username[0].toUpperCase()}
      </div>
      <span>${user.username}</span>
    `;
    
    div.onclick = () => insertMention(user.username);
    autocomplete.appendChild(div);
  });
}

function hideMentionAutocomplete() {
  $('mention-autocomplete').classList.add('hidden');
  mentionIndex = -1;
}

function insertMention(username) {
  const input = $('msg-input');
  const text = input.value;
  const cursorPos = input.selectionStart;
  
  // Trouver le début du @
  const beforeCursor = text.substring(0, cursorPos);
  const match = beforeCursor.match(/@(\w*)$/);
  
  if (match) {
    const startPos = cursorPos - match[0].length;
    const newText = text.substring(0, startPos) + '@' + username + ' ' + text.substring(cursorPos);
    input.value = newText;
    input.focus();
    input.selectionStart = input.selectionEnd = startPos + username.length + 2;
  }
  
  hideMentionAutocomplete();
}

// FICHIERS
$('file-input').onchange = async () => {
  const file = $('file-input').files[0];
  if (!file || !currentChannel) return;
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch(SERVER_URL + '/upload', { method: 'POST', body: fd });
    const data = await res.json();
    socket.emit('send_message', { channelId: currentChannel, content: '', fileUrl: data.url, fileName: data.name, type: file.type.startsWith('image/') ? 'image' : 'file' });
  } catch (e) { console.error('Upload échoué:', e); }
  $('file-input').value = '';
};

// VOIX
async function joinVoiceChannel(ch) {
  if (currentVoiceChannel) await leaveVoice();
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true, // Toujours actif
        autoGainControl: true,
        googNoiseSuppression: true,
        googHighpassFilter: true,
        googEchoCancellation: true
      },
      video: false
    });
  }
  catch { alert('Impossible d\'accéder au micro !'); return; }

  currentVoiceChannel = ch.id;
  localStorage.setItem('currentVoiceChannel', JSON.stringify({ id: ch.id, name: ch.name }));
  document.querySelectorAll('.channel-item').forEach(e => e.classList.remove('active'));
  document.getElementById('ch-' + ch.id)?.classList.add('active');
  $('voice-bar').classList.remove('hidden');
  $('voice-bar-name').textContent = ch.name;
  $('remote-streams').classList.remove('hidden');
  socket.emit('join_voice', ch.id);
  joinSound.play().catch(() => { });

  // Analyser ton propre micro pour l'indicateur visuel
audioContextInstance = new (window.AudioContext || window.webkitAudioContext)();
const analyser = audioContextInstance.createAnalyser();
micGainNode = audioContextInstance.createGain();
const source = audioContextInstance.createMediaStreamSource(localStream);

// Appliquer le volume micro sauvegardé
micGainNode.gain.value = savedMicVolume / 100;

analyser.fftSize = 256;
const bufferLength = analyser.frequencyBinCount;
const dataArray = new Uint8Array(bufferLength);


// Créer une destination MediaStream pour envoyer le son traité aux peers
const micDestination = audioContextInstance.createMediaStreamDestination();

// Connecter : source → gain → destination WebRTC
source.connect(micGainNode);
micGainNode.connect(micDestination);

// Remplacer le localStream par le stream traité pour WebRTC
const processedStream = micDestination.stream;
// Ajouter la piste audio traitée au localStream
const originalTrack = localStream.getAudioTracks()[0];
localStream.removeTrack(originalTrack);
localStream.addTrack(processedStream.getAudioTracks()[0]);

// Créer les filtres audio
const compressor = audioContextInstance.createDynamicsCompressor();
const biquadFilter = audioContextInstance.createBiquadFilter();
const gateGainNode = audioContextInstance.createGain(); // Gain séparé pour le gate

// Configurer le compresseur
compressor.threshold.value = -50;
compressor.knee.value = 40;
compressor.ratio.value = 12;
compressor.attack.value = 0;
compressor.release.value = 0.25;

// Configurer l'égaliseur (boost aigus)
biquadFilter.type = 'highshelf';
biquadFilter.frequency.value = 3000;
biquadFilter.gain.value = 0;

// Brancher l'analyseur directement sur le micGain (pour le rond vert)
micGainNode.connect(analyser);

// Connecter en chaîne : micGain → gateGain → compressor → filter
let currentNode = micGainNode;

// Ajouter le gate gain node
currentNode.connect(gateGainNode);
currentNode = gateGainNode;

if (compressorEnabled) {
  currentNode.connect(compressor);
  currentNode = compressor;
}

if (equalizerEnabled) {
  currentNode.connect(biquadFilter);
  currentNode = biquadFilter;
}

// Stocker les nœuds
window.audioFilters = {
  compressor,
  biquadFilter,
  gateGainNode,
  analyser,
  lastNode: currentNode
};

  // Surveiller le niveau audio de ton propre micro
const checkMyAudioLevel = () => {
  if (!currentVoiceChannel) return;
  
  analyser.getByteFrequencyData(dataArray);
  const average = dataArray.reduce((a, b) => a + b) / bufferLength;
  
  // Gate de bruit : couper le micro si niveau trop bas
if (noiseGateEnabled && window.audioFilters && window.audioFilters.gateGainNode) {
  const threshold = noiseReductionEnabled ? 30 : 15;
  if (average < threshold) {
    window.audioFilters.gateGainNode.gain.value = 0; // Couper
  } else {
    window.audioFilters.gateGainNode.gain.value = 1.0; // Restaurer
  }
}
  
  const isSpeaking = average > 15;
  
  updateMyVoiceIndicator(isSpeaking);
  
  requestAnimationFrame(checkMyAudioLevel);
};

  checkMyAudioLevel();
}

$('leave-voice-btn').onclick = leaveVoice;

async function leaveVoice() {
  if (!currentVoiceChannel) return;
  
  const channelToLeave = currentVoiceChannel; // ✅ Sauvegarder avant de nullifier
  
  // Nettoyer immédiatement
  currentVoiceChannel = null;
  localStorage.removeItem('currentVoiceChannel');
  
  // Envoyer au serveur avec la valeur sauvegardée
  socket.emit('leave_voice', channelToLeave);
  
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  Object.keys(peers).forEach(id => { peers[id].peer.destroy(); });
  peers = {};
  $('remote-streams').innerHTML = '';
  $('remote-streams').classList.add('hidden');
  $('voice-bar').classList.add('hidden');
  document.getElementById('ch-' + channelToLeave)?.classList.remove('active');
  leaveSound.play().catch(() => { });
}

$('mute-btn').onclick = () => {
  isMuted = !isMuted;
  if (localStream) localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
  $('mute-btn').textContent = isMuted ? '🔇' : '🎙️';
  $('mute-btn').classList.toggle('active', isMuted);
};

$('deafen-btn').onclick = () => {
  isDeafened = !isDeafened;
  
  Object.keys(peers).forEach(peerId => {
    if (window.peerGainNodes && window.peerGainNodes[peerId] && window.peerAudioContexts[peerId]) {
      if (isDeafened) {
        window.peerGainNodes[peerId].gain.setTargetAtTime(0, window.peerAudioContexts[peerId].currentTime, 0.01);
      } else {
        const vol = userVolumes[peerId] !== undefined ? userVolumes[peerId] : 100;
        const gainValue = vol <= 100 ? vol / 100 : 1 + ((vol - 100) / 100 * 1.5);
        window.peerGainNodes[peerId].gain.setTargetAtTime(gainValue, window.peerAudioContexts[peerId].currentTime, 0.01);
      }
    }
  });

  $('deafen-btn').textContent = isDeafened ? '🔕' : '🔊';
  $('deafen-btn').classList.toggle('active', isDeafened);
};

$('screen-btn').onclick = async () => {
  if (!currentVoiceChannel) return;
  if (isSharing) {
    if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
    isSharing = false;
    $('screen-btn').classList.remove('active');
    $('screen-btn').textContent = '🖥️';
    // Signaler aux autres que je ne stream plus
socket.emit('user_streaming', { username: myUsername, streaming: false });
  } else {
    try {
      // Récupérer les sources disponibles
      const sources = await window.electronAPI.getDesktopSources();

      if (!sources || sources.length === 0) {
        console.error('Aucune source d\'écran disponible');
        return;
      }

      // Afficher le modal de sélection
      const modal = $('screen-source-modal');
      const sourcesList = $('screen-sources-list');
      const cancelBtn = $('screen-source-cancel-btn');

      // Vider la liste
      sourcesList.innerHTML = '';

      // Ajouter chaque source
      sources.forEach(source => {
        const item = document.createElement('div');
        item.className = 'screen-source-item';
        item.innerHTML = `
        <img src="${source.thumbnail.toDataURL()}" alt="${source.name}">
        <p>${source.name}</p>
      `;

        item.onclick = async () => {
          modal.classList.add('hidden');
          await startScreenShare(source.id);
        };

        sourcesList.appendChild(item);
      });

      modal.classList.remove('hidden');

      cancelBtn.onclick = () => {
        modal.classList.add('hidden');
      };

    } catch (e) {
      console.error('Screen share échoué:', e);
    }
  }
};

async function startScreenShare(sourceId) {
  try {
    screenStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      },
      video: {
        mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
        maxWidth: streamQuality === 'hd' ? 1920 : 1280,
        maxHeight: streamQuality === 'hd' ? 1080 : 720,
        maxFrameRate: streamQuality === 'hd' ? 60 : 30,
        minBitrate: streamQuality === 'hd' ? 6000000 : 2500000,  // 6 Mbps HD, 2.5 Mbps SD
        maxBitrate: streamQuality === 'hd' ? 8000000 : 4000000   // 8 Mbps HD, 4 Mbps SD
        }
      }
    });

    isSharing = true;
    $('screen-btn').classList.add('active');
    $('screen-btn').textContent = '🛑';
    screenStream.getVideoTracks()[0].onended = () => $('screen-btn').click();


    // Diffuser le flux d'écran à tous les peers connectés
    Object.keys(peers).forEach(peerId => {
      const peerData = peers[peerId];
      if (peerData && peerData.peer) {
        peerData.peer.addStream(screenStream);
        // Signaler aux autres que je stream
    socket.emit('user_streaming', { username: myUsername, streaming: true });
      }
    });
  } catch (e) {
    console.error('Screen share échoué:', e);
  }
}
// ═══════════════════════════════════════════════════════════════
// GESTION DES BADGES DE NOTIFICATION
// ═══════════════════════════════════════════════════════════════

function updateChannelBadges() {
  console.log('updateChannelBadges appelé, unreadCounts:', unreadCounts); // ← DEBUG
  Object.keys(unreadCounts).forEach(channelId => {
    const count = unreadCounts[channelId];
    const channelEl = document.getElementById('ch-' + channelId);
    console.log('Salon:', channelId, 'count:', count, 'element trouvé:', channelEl); // ← DEBUG
    if (!channelEl) return;

    const oldBadge = channelEl.querySelector('.channel-badge');
    if (oldBadge) oldBadge.remove();

    if (count > 0) {
      const badge = document.createElement('span');
      badge.className = 'channel-badge';
      badge.textContent = count > 99 ? '99+' : count;
      channelEl.appendChild(badge);
      console.log('Badge ajouté sur', channelId, 'avec count:', count); // ← DEBUG
    }
  });
}

function updateFriendsBadge() {
  const total = Object.values(unreadPMs).reduce((a, b) => a + b, 0);
  const friendsBtn = $('friends-btn');
  
  // Supprimer l'ancien badge
  const oldBadge = friendsBtn.querySelector('.friends-badge');
  if (oldBadge) oldBadge.remove();
  
  if (total > 0) {
    const badge = document.createElement('span');
    badge.className = 'friends-badge';
    badge.textContent = total > 99 ? '99+' : total;
    friendsBtn.appendChild(badge);
  }
}

// WebRTC
async function createPeer(peerId, initiator, username) {
  const peer = new SimplePeer({
    initiator, stream: localStream, trickle: true,
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
  });
  peer.on('signal', signal => socket.emit('signal', { to: peerId, signal }));
  peer.on('stream', stream => {
    // Vérifier s'il y a une vidéo (partage d'écran)
    const hasVideo = stream.getVideoTracks().length > 0;

    if (hasVideo) {
  // Supprimer l'ancien container s'il existe
  const oldBox = document.getElementById('stream-' + peerId);
  if (oldBox) oldBox.remove();

  // Créer un container pour la vidéo + bouton fermer
  const box = document.createElement('div');
  box.id = 'stream-' + peerId;
  box.className = 'stream-box';
  
  const video = document.createElement('video');
  video.className = 'remote-video';
  video.autoplay = true;
  video.srcObject = stream;
  
  const closeBtn = document.createElement('button');
  closeBtn.className = 'stream-close-btn';
  closeBtn.textContent = '✕';
  closeBtn.onclick = () => {
  box.style.display = 'none'; // Cacher au lieu de supprimer
};
  
  video.onclick = () => {
    video.classList.toggle('video-enlarged');
  };
  
  box.appendChild(video);
  box.appendChild(closeBtn);

  // Toggle HD/SD
const qualityToggle = document.createElement('button');
qualityToggle.className = 'stream-quality-toggle';
qualityToggle.textContent = streamQuality.toUpperCase();
qualityToggle.classList.add(streamQuality);
qualityToggle.title = 'Basculer qualité HD/SD';

qualityToggle.onclick = () => {
  streamQuality = streamQuality === 'hd' ? 'sd' : 'hd';
  localStorage.setItem('streamQuality', streamQuality);
  qualityToggle.textContent = streamQuality.toUpperCase();
  qualityToggle.classList.toggle('hd');
  qualityToggle.classList.toggle('sd');
  
  // Info à l'utilisateur
  alert(`Qualité changée en ${streamQuality.toUpperCase()}. Relancez le partage d'écran pour appliquer.`);
};

box.appendChild(qualityToggle);

  $('remote-streams').appendChild(box);
  
  // Détecter quand le stream s'arrête
  stream.getVideoTracks()[0].onended = () => box.remove();

    } else {
      // Audio seulement - élément audio pour la sortie + GainNode pour le volume
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.className = 'remote-audio';
      audio.setAttribute('data-peer-id', peerId);
      if (isDeafened) audio.muted = true;
      document.body.appendChild(audio);
      audio.srcObject = stream;

      // Stocker l'élément audio
      if (!window.peerAudioElements) window.peerAudioElements = {};
      window.peerAudioElements[peerId] = audio;

      // Appliquer le volume sauvegardé (0-100% via audio.volume)
      const savedVolume = userVolumes[peerId] !== undefined ? userVolumes[peerId] : 100;
      audio.volume = Math.min(savedVolume / 100, 1.0);

      // Analyser pour le rond vert
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const checkAudioLevel = () => {
        if (!peers[peerId]) return;
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a, b) => a + b) / bufferLength;
        updateVoiceIndicator(peerId, average > 15);
        requestAnimationFrame(checkAudioLevel);
      };
      checkAudioLevel();
    }
  });
  peer.on('error', e => console.error('Peer error:', e));
  peers[peerId] = { peer, username };
}

function updateVoiceIndicator(peerId, isSpeaking) {
  // Trouver l'avatar de cet utilisateur dans tous les salons vocaux
  const username = peers[peerId]?.username;
  if (!username) return;
  
  // Chercher tous les avatars de cet utilisateur dans la sidebar
  document.querySelectorAll('.voice-user-avatar-small').forEach(avatar => {
    const parent = avatar.closest('.voice-user-item-sidebar');
    if (parent && parent.textContent.includes(username)) {
      if (isSpeaking) {
        avatar.classList.add('speaking');
      } else {
        avatar.classList.remove('speaking');
      }
    }
  });
}

function updateMyVoiceIndicator(isSpeaking) {
  
  // Chercher tous les avatars de ton propre utilisateur dans la sidebar
  document.querySelectorAll('.voice-user-avatar-small').forEach(avatar => {
    const parent = avatar.closest('.voice-user-item-sidebar');
    if (parent && parent.textContent.includes(myUsername)) {
      if (isSpeaking) {
        avatar.classList.add('speaking');
      } else {
        avatar.classList.remove('speaking');
      }
    }
  });
}

function updateStreamIndicator(username, streaming) {
  // Tracker qui stream
  if (streaming) {
    streamingUsers.add(username);
    
    // Ouvrir automatiquement la fenêtre du stream
    const peerEntry = Object.entries(peers).find(([id, data]) => data.username === username);
    if (peerEntry) {
      const streamBox = document.getElementById('stream-' + peerEntry[0]);
      if (streamBox) streamBox.style.display = '';
    }
  } else {
    streamingUsers.delete(username);
    
    // Fermer automatiquement la fenêtre du stream
    const peerEntry = Object.entries(peers).find(([id, data]) => data.username === username);
    if (peerEntry) {
      const streamBox = document.getElementById('stream-' + peerEntry[0]);
      if (streamBox) streamBox.style.display = 'none';
    }
  }
  
  // Chercher tous les utilisateurs dans la sidebar
  document.querySelectorAll('.voice-user-item-sidebar').forEach(item => {
    if (item.textContent.includes(username)) {
      let streamBtn = item.querySelector('.stream-indicator-btn');
      
      if (streaming) {
        // Ajouter le bouton rouge s'il n'existe pas
        if (!streamBtn) {
          streamBtn = document.createElement('button');
          streamBtn.className = 'stream-indicator-btn';
          streamBtn.textContent = '🔴';
          streamBtn.title = 'Voir le stream';
          streamBtn.onclick = () => toggleStreamWindow(username);
          item.appendChild(streamBtn);
        }
      } else {
        // Retirer le bouton s'il existe
        if (streamBtn) streamBtn.remove();
      }
    }
  });
}

function toggleStreamWindow(username) {
  // Trouver le peerId correspondant à ce username
  const peerEntry = Object.entries(peers).find(([id, data]) => data.username === username);
  if (!peerEntry) return;
  
  const peerId = peerEntry[0];
  const streamBox = document.getElementById('stream-' + peerId);
  
  if (streamBox) {
    // Si la fenêtre existe, la fermer ou l'afficher
    if (streamBox.style.display === 'none') {
      streamBox.style.display = '';
    } else {
      streamBox.style.display = 'none';
    }
  }
}

$('members-btn').onclick = () => {
  const p = $('members-panel');
  p.style.display = p.style.display === 'none' ? '' : 'none';
};

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// ═══════════════════════════════════════════════════════════════
// EMOJI/GIF PICKER
// ═══════════════════════════════════════════════════════════════

const emojis = ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '☺️', '😚', '😙', '🥲', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤫', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '🤥', '😌', '😔', '😪', '🤤', '😴', '😷', '🤒', '🤕', '🤢', '🤮', '🤧', '🥵', '🥶', '🥴', '😵', '🤯', '🤠', '🥳', '🥸', '😎', '🤓', '🧐', '😕', '😟', '🙁', '☹️', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '👾', '🤖', '😺', '😸', '😹', '😻', '😼', '😽', '🙀', '😿', '😾', '🙈', '🙉', '🙊', '💋', '💌', '💘', '💝', '💖', '💗', '💓', '💞', '💕', '💟', '❣️', '💔', '❤️', '🧡', '💛', '💚', '💙', '💜', '🤎', '🖤', '🤍', '💯', '💢', '💥', '💫', '💦', '💨', '🕳️', '💬', '👁️‍🗨️', '🗨️', '🗯️', '💭', '💤', '👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳', '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '🧠', '🫀', '🫁', '🦷', '🦴', '👀', '👁️', '👅', '👄', '🎂', '🎉', '🎊', '🎈', '🎁', '🏆', '🏅', '🥇', '🥈', '🥉', '⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️', '🤼', '🤸', '🤺', '⛹️', '🤾', '🏌️', '🏇', '🧘', '🏊', '🤽', '🚣', '🧗', '🚴', '🚵', '🎖️', '🎗️', '🎫', '🎟️', '🎪', '🎭', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🪘', '🎷', '🎺', '🪗', '🎸', '🪕', '🎻', '🎲', '♟️', '🎯', '🎳', '🎮', '🎰', '🧩'];

const emojiPicker = $('emoji-picker');
const emojiBtn = $('emoji-btn');
const emojiGrid = $('emoji-grid');
const gifGrid = $('gif-grid');
const gifSearch = $('gif-search');
const emojiContent = $('emoji-content');
const gifContent = $('gif-content');

// Remplir les émojis
emojis.forEach(emoji => {
  const div = document.createElement('div');
  div.className = 'emoji-item';
  div.textContent = emoji;
  div.onclick = () => {
    $('msg-input').value += emoji;
    $('msg-input').focus();
  };
  emojiGrid.appendChild(div);
});

// Toggle picker
emojiBtn.onclick = (e) => {
  e.stopPropagation();
  emojiPicker.classList.toggle('hidden');
};

// Fermer si clic ailleurs
document.addEventListener('click', (e) => {
  if (!emojiPicker.contains(e.target) && e.target !== emojiBtn) {
    emojiPicker.classList.add('hidden');
  }
});

// Tabs émoji/gif
document.querySelectorAll('.emoji-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.emoji-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    if (tab.dataset.tab === 'emoji') {
      emojiContent.classList.remove('hidden');
      gifContent.classList.add('hidden');
    } else {
      emojiContent.classList.add('hidden');
      gifContent.classList.remove('hidden');
      if (gifGrid.children.length === 0) loadTrendingGifs();
    }
  };
});

// Recherche GIF
let gifTimeout;
gifSearch.oninput = () => {
  clearTimeout(gifTimeout);
  gifTimeout = setTimeout(() => {
    const query = gifSearch.value.trim();
    if (query) searchGifs(query);
    else loadTrendingGifs();
  }, 500);
};

// Charger GIFs tendance
async function loadTrendingGifs() {
  gifGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--t3);padding:20px">Chargement...</div>';
  try {
    const res = await fetch('https://tenor.googleapis.com/v2/featured?key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ&limit=20');
    const data = await res.json();
    displayGifs(data.results);
  } catch {
    gifGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--red);padding:20px">Erreur de chargement</div>';
  }
}

// Rechercher GIFs
async function searchGifs(query) {
  gifGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--t3);padding:20px">Recherche...</div>';
  try {
    const res = await fetch(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(query)}&key=AIzaSyAyimkuYQYF_FXVALexPuGQctUWRURdCYQ&limit=20`);
    const data = await res.json();
    displayGifs(data.results);
  } catch {
    gifGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--red);padding:20px">Erreur de recherche</div>';
  }
}

// Afficher GIFs
function displayGifs(gifs) {
  gifGrid.innerHTML = '';
  if (!gifs || gifs.length === 0) {
    gifGrid.innerHTML = '<div style="grid-column:1/-1;text-align:center;color:var(--t3);padding:20px">Aucun résultat</div>';
    return;
  }
  gifs.forEach(gif => {
    const img = document.createElement('img');
    img.className = 'gif-item';
    img.src = gif.media_formats.tinygif.url;
    img.onclick = () => {
      const gifUrl = gif.media_formats.gif.url;
      socket.emit('send_message', { channelId: currentChannel, content: gifUrl, fileUrl: null, fileName: null, type: 'text' });
      emojiPicker.classList.add('hidden');
    };
    gifGrid.appendChild(img);
  });
}

// Écouter les modifications de messages
socket.on('message_edited', ({ messageId, content, edited }) => {
  const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!msgEl) return;

  const contentEl = msgEl.querySelector('.msg-content');
  const timeEl = msgEl.querySelector('.msg-time');

  if (contentEl) contentEl.textContent = content;
  if (timeEl && edited && !msgEl.querySelector('.msg-edited')) {
    timeEl.insertAdjacentHTML('afterend', '<span class="msg-edited">(modifié)</span>');
  }
});

// Écouter les suppressions de messages
socket.on('message_deleted', ({ messageId }) => {
  const msgEl = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (msgEl) msgEl.remove();
});