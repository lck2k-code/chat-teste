// ==========================================
// ChatFlow - Real-time Chat Application
// ==========================================

// ----- Configuration -----
const CONFIG = {
    HEARTBEAT_INTERVAL: 3000,
    USER_TIMEOUT: 12000,
    MESSAGE_CLEANUP_INTERVAL: 1000,
    MAX_IMAGE_SIZE: 5 * 1024 * 1024, // 5MB
    IMAGE_QUALITY: 0.7,
    MAX_IMAGE_DIMENSION: 1200,
    COLORS: [
        '#8B5CF6', '#06b6d4', '#ec4899', '#f59e0b',
        '#10b981', '#ef4444', '#3b82f6', '#f97316'
    ]
};

// ----- State -----
const state = {
    currentView: 'home',
    user: null,
    userId: null,
    room: null,
    isOwner: false,
    messages: [],
    onlineUsers: new Map(),
    disappearing: false,
    disappearTime: 30,
    pendingDisappearingMsg: null,
    selectedImage: null,
    mediaRecorder: null,
    audioChunks: [],
    recordingInterval: null,
    recordingSeconds: 0,
    heartbeatInterval: null,
    userCheckInterval: null,
    messageCleanupInterval: null
};

// ----- BroadcastChannel -----
let channel;
try {
    channel = new BroadcastChannel('chatflow');
    channel.onmessage = (event) => handleBroadcast(event.data);
} catch (e) {
    console.warn('BroadcastChannel not supported, using localStorage fallback');
    channel = { postMessage: () => {} };
}

// ----- Utility Functions -----
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

async function hashPassword(password) {
    if (!password) return '';
    const encoder = new TextEncoder();
    const data = encoder.encode(password + 'chatflow_salt_2024');
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function getUserColor(name) {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    return CONFIG.COLORS[Math.abs(hash) % CONFIG.COLORS.length];
}

function getInitials(name) {
    return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatDuration(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// ----- Toast Notifications -----
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const icons = {
        success: 'check-circle',
        error: 'alert-circle',
        info: 'info',
        warning: 'alert-triangle'
    };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<i data-lucide="${icons[type]}" class="w-5 h-5 flex-shrink-0"></i><span>${message}</span>`;
    container.appendChild(toast);
    lucide.createIcons({ nodes: [toast] });

    setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ----- View Management -----
function showView(viewName) {
    const views = document.querySelectorAll('.view');
    views.forEach(v => {
        v.classList.remove('active');
        v.style.display = 'none';
    });

    const target = document.getElementById(`view-${viewName}`);
    if (target) {
        target.style.display = '';
        // Force reflow
        target.offsetHeight;
        target.classList.add('active');
    }

    state.currentView = viewName;

    // Restore saved username
    if (viewName === 'create' || viewName === 'join') {
        const prefs = loadPreferences();
        if (prefs.lastUsername) {
            const input = document.getElementById(viewName + '-username');
            if (input) input.value = prefs.lastUsername;
        }
    }

    lucide.createIcons();
}

// ----- Room Type Toggle -----
document.addEventListener('change', (e) => {
    if (e.target.name === 'room-type') {
        const passwordField = document.getElementById('create-password-field');
        const passwordInput = document.getElementById('create-password');
        if (e.target.value === 'private') {
            passwordField.classList.remove('hidden');
            passwordInput.required = true;
        } else {
            passwordField.classList.add('hidden');
            passwordInput.required = false;
            passwordInput.value = '';
        }
        // Update button styles
        document.querySelectorAll('.room-type-btn').forEach(btn => {
            btn.classList.toggle('active', btn.querySelector('input').checked);
        });
    }
});

// ----- Local Storage -----
function loadPreferences() {
    try {
        return JSON.parse(localStorage.getItem('chatflow_prefs') || '{}');
    } catch { return {}; }
}

function savePreferences(prefs) {
    try {
        localStorage.setItem('chatflow_prefs', JSON.stringify(prefs));
    } catch (e) { console.warn('Failed to save preferences', e); }
}

function saveRoomData(roomData) {
    try {
        localStorage.setItem(`chatflow_room_${roomData.name}`, JSON.stringify(roomData));
    } catch (e) { console.warn('Failed to save room data', e); }
}

function loadRoomData(roomName) {
    try {
        return JSON.parse(localStorage.getItem(`chatflow_room_${roomName}`));
    } catch { return null; }
}

function removeRoomData(roomName) {
    try {
        localStorage.removeItem(`chatflow_room_${roomName}`);
        localStorage.removeItem(`chatflow_messages_${roomName}`);
    } catch (e) { console.warn('Failed to remove room data', e); }
}

function saveMessages(roomName, messages) {
    try {
        // Don't save disappearing messages
        const toSave = messages.filter(m => !m.disappearing);
        localStorage.setItem(`chatflow_messages_${roomName}`, JSON.stringify(toSave));
    } catch (e) { console.warn('Failed to save messages', e); }
}

function loadMessages(roomName) {
    try {
        return JSON.parse(localStorage.getItem(`chatflow_messages_${roomName}`) || '[]');
    } catch { return []; }
}

// ----- Create Room -----
async function handleCreateRoom(event) {
    event.preventDefault();

    const username = document.getElementById('create-username').value.trim();
    const roomName = document.getElementById('create-roomname').value.trim();
    const roomType = document.querySelector('input[name="room-type"]:checked').value;
    const password = document.getElementById('create-password').value;

    if (!username || !roomName) {
        showToast('Preencha todos os campos obrigatórios', 'error');
        return;
    }

    // Check if room already exists
    const existing = loadRoomData(roomName);
    if (existing) {
        showToast('Uma sala com esse nome já existe', 'error');
        return;
    }

    const passwordHash = roomType === 'private' ? await hashPassword(password) : '';

    const roomData = {
        name: roomName,
        isPrivate: roomType === 'private',
        passwordHash: passwordHash,
        owner: username,
        createdAt: Date.now()
    };

    saveRoomData(roomData);

    state.user = username;
    state.userId = generateId();
    state.room = roomName;
    state.isOwner = true;
    state.messages = [];

    // Save preferences
    savePreferences({ ...loadPreferences(), lastUsername: username });

    // Enter chat
    enterChat(roomData);

    showToast('Sala criada com sucesso!', 'success');
}

// ----- Join Room -----
async function handleJoinRoom(event) {
    event.preventDefault();

    const username = document.getElementById('join-username').value.trim();
    const roomName = document.getElementById('join-roomname').value.trim();
    const password = document.getElementById('join-password').value;

    if (!username || !roomName) {
        showToast('Preencha todos os campos obrigatórios', 'error');
        return;
    }

    const roomData = loadRoomData(roomName);
    if (!roomData) {
        showToast('Sala não encontrada. Verifique o nome.', 'error');
        return;
    }

    // Check password
    if (roomData.isPrivate) {
        const passwordHash = await hashPassword(password);
        if (passwordHash !== roomData.passwordHash) {
            showToast('Senha incorreta', 'error');
            return;
        }
    }

    state.user = username;
    state.userId = generateId();
    state.room = roomName;
    state.isOwner = (username === roomData.owner);
    state.messages = loadMessages(roomName);

    // Save preferences
    savePreferences({ ...loadPreferences(), lastUsername: username });

    // Enter chat
    enterChat(roomData);

    showToast('Você entrou na sala!', 'success');
}

// ----- Enter Chat -----
function enterChat(roomData) {
    // Set header info
    document.getElementById('chat-room-name').textContent = roomData.name;
    document.getElementById('chat-room-type').textContent = roomData.isPrivate ? '🔒 Privada' : '🌐 Pública';

    // Show owner controls
    const clearBtn = document.getElementById('btn-clear-chat');
    if (state.isOwner) {
        clearBtn.classList.remove('hidden');
        clearBtn.classList.add('flex');
    } else {
        clearBtn.classList.add('hidden');
        clearBtn.classList.remove('flex');
    }

    // Load existing messages
    renderMessages();

    // Add user to online list
    state.onlineUsers.set(state.userId, {
        name: state.user,
        lastSeen: Date.now(),
        color: getUserColor(state.user)
    });

    // Broadcast join
    broadcast({
        type: 'user-join',
        room: state.room,
        userId: state.userId,
        userName: state.user
    });

    // Add system message
    addSystemMessage(`${state.user} entrou na sala`);

    // Start heartbeat
    startHeartbeat();

    // Start user check
    startUserCheck();

    // Switch to chat view
    showView('chat');

    // Focus input
    setTimeout(() => {
        document.getElementById('message-input').focus();
    }, 300);
}

// ----- Leave Room -----
function handleLeaveRoom() {
    if (confirm('Deseja realmente sair da sala?')) {
        // Broadcast leave
        broadcast({
            type: 'user-leave',
            room: state.room,
            userId: state.userId,
            userName: state.user
        });

        addSystemMessage(`${state.user} saiu da sala`);

        // Check if room should be cleaned up
        cleanupOnLeave();

        // Reset state
        stopHeartbeat();
        stopUserCheck();
        state.onlineUsers.delete(state.userId);

        state.user = null;
        state.userId = null;
        state.room = null;
        state.isOwner = false;
        state.messages = [];
        state.disappearing = false;
        state.selectedImage = null;

        // Reset UI
        document.getElementById('messages-list').innerHTML = '';
        document.getElementById('users-list').innerHTML = '';
        document.getElementById('users-list-mobile').innerHTML = '';
        document.getElementById('disappear-bar').classList.add('hidden');
        document.getElementById('disappear-selector').classList.add('hidden');
        document.getElementById('btn-clear-chat').classList.add('hidden');

        showView('home');
        showToast('Você saiu da sala', 'info');
    }
}

function cleanupOnLeave() {
    // Remove user from online list
    state.onlineUsers.delete(state.userId);

    // If no users left, clean up room data
    if (state.onlineUsers.size === 0) {
        removeRoomData(state.room);
    }
}

// ----- Broadcast Communication -----
function broadcast(data) {
    try {
        channel.postMessage(data);
    } catch (e) { console.warn('Broadcast failed', e); }

    // Also use localStorage for cross-tab sync
    try {
        localStorage.setItem('chatflow_event', JSON.stringify({ ...data, _t: Date.now() }));
        localStorage.removeItem('chatflow_event');
    } catch (e) {}
}

// Listen for localStorage changes (cross-tab)
window.addEventListener('storage', (e) => {
    if (e.key === 'chatflow_event' && e.newValue) {
        try {
            const data = JSON.parse(e.newValue);
            if (data.room === state.room) {
                handleBroadcast(data);
            }
        } catch {}
    }
});

function handleBroadcast(data) {
    if (data.room !== state.room) return;

    switch (data.type) {
        case 'message':
            handleIncomingMessage(data.message);
            break;
        case 'user-join':
            if (data.userId !== state.userId) {
                state.onlineUsers.set(data.userId, {
                    name: data.userName,
                    lastSeen: Date.now(),
                    color: getUserColor(data.userName)
                });
                updateUsersUI();
                addSystemMessage(`${data.userName} entrou na sala`);
                showToast(`${data.userName} entrou na sala`, 'info');
            }
            break;
        case 'user-leave':
            if (data.userId !== state.userId) {
                const userName = state.onlineUsers.get(data.userId)?.name || data.userName;
                state.onlineUsers.delete(data.userId);
                updateUsersUI();
                addSystemMessage(`${userName} saiu da sala`);

                // If no users left, clean up
                if (state.onlineUsers.size === 0) {
                    removeRoomData(state.room);
                }
            }
            break;
        case 'heartbeat':
            if (data.userId !== state.userId) {
                state.onlineUsers.set(data.userId, {
                    name: data.userName,
                    lastSeen: Date.now(),
                    color: getUserColor(data.userName)
                });
                updateUsersUI();
            }
            break;
        case 'clear':
            state.messages = [];
            renderMessages();
            saveMessages(state.room, state.messages);
            showToast('O histórico do chat foi limpo pelo dono', 'warning');
            break;
        case 'viewed':
            handleMessageViewed(data.messageId);
            break;
    }
}

// ----- Heartbeat -----
function startHeartbeat() {
    stopHeartbeat();
    state.heartbeatInterval = setInterval(() => {
        broadcast({
            type: 'heartbeat',
            room: state.room,
            userId: state.userId,
            userName: state.user
        });

        // Update own last seen
        if (state.onlineUsers.has(state.userId)) {
            state.onlineUsers.get(state.userId).lastSeen = Date.now();
        }
    }, CONFIG.HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
    if (state.heartbeatInterval) {
        clearInterval(state.heartbeatInterval);
        state.heartbeatInterval = null;
    }
}

// ----- User Check -----
function startUserCheck() {
    stopUserCheck();
    state.userCheckInterval = setInterval(() => {
        const now = Date.now();
        let changed = false;
        state.onlineUsers.forEach((user, id) => {
            if (id !== state.userId && now - user.lastSeen > CONFIG.USER_TIMEOUT) {
                state.onlineUsers.delete(id);
                changed = true;
            }
        });
        if (changed) updateUsersUI();
    }, 5000);
}

function stopUserCheck() {
    if (state.userCheckInterval) {
        clearInterval(state.userCheckInterval);
        state.userCheckInterval = null;
    }
}

// ----- Update Users UI -----
function updateUsersUI() {
    const count = state.onlineUsers.size;
    document.getElementById('chat-online-count').textContent = `${count} online`;

    const renderList = (container) => {
        container.innerHTML = '';
        state.onlineUsers.forEach((user, id) => {
            const isCurrentUser = id === state.userId;
            const div = document.createElement('div');
            div.className = 'user-item';
            div.innerHTML = `
                <div class="relative">
                    <div class="user-avatar" style="background:${user.color}">${getInitials(user.name)}</div>
                    <div class="user-status"></div>
                </div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-gray-200 truncate">${user.name}${isCurrentUser ? ' (você)' : ''}</p>
                </div>
            `;
            container.appendChild(div);
        });
    };

    renderList(document.getElementById('users-list'));
    renderList(document.getElementById('users-list-mobile'));
    lucide.createIcons();
}

// ----- Sidebar Toggle -----
function toggleSidebar() {
    const overlay = document.getElementById('sidebar-overlay');
    const mobile = document.getElementById('sidebar-mobile');

    if (mobile.classList.contains('translate-x-full')) {
        overlay.classList.remove('hidden');
        mobile.classList.remove('translate-x-full');
    } else {
        overlay.classList.add('hidden');
        mobile.classList.add('translate-x-full');
    }
}

// ----- Send Message -----
function sendMessage() {
    const input = document.getElementById('message-input');
    const text = input.value.trim();

    if (!state.room || !state.user) return;

    // Check for image
    if (state.selectedImage) {
        sendImageMessage(state.selectedImage);
        cancelImage();
        input.value = '';
        return;
    }

    if (!text) return;

    const message = {
        id: generateId(),
        userId: state.userId,
        user: state.user,
        type: 'text',
        content: text,
        timestamp: Date.now(),
        disappearing: state.disappearing,
        disappearTime: state.disappearing ? state.disappearTime : 0,
        viewed: false
    };

    state.messages.push(message);
    renderMessages();
    saveMessages(state.room, state.messages);

    broadcast({ type: 'message', room: state.room, message });

    input.value = '';
    input.focus();

    // Handle disappearing for sender
    if (message.disappearing) {
        startDisappearingTimer(message.id, message.disappearTime);
    }
}

function sendImageMessage(imageData) {
    const message = {
        id: generateId(),
        userId: state.userId,
        user: state.user,
        type: 'image',
        content: imageData.data,
        fileName: imageData.name,
        timestamp: Date.now(),
        disappearing: state.disappearing,
        disappearTime: state.disappearing ? state.disappearTime : 0,
        viewed: false
    };

    state.messages.push(message);
    renderMessages();
    saveMessages(state.room, state.messages);

    broadcast({ type: 'message', room: state.room, message });

    if (message.disappearing) {
        startDisappearingTimer(message.id, message.disappearTime);
    }
}

function sendAudioMessage(audioData) {
    const message = {
        id: generateId(),
        userId: state.userId,
        user: state.user,
        type: 'audio',
        content: audioData.data,
        duration: audioData.duration,
        timestamp: Date.now(),
        disappearing: state.disappearing,
        disappearTime: state.disappearing ? state.disappearTime : 0,
        viewed: false
    };

    state.messages.push(message);
    renderMessages();
    saveMessages(state.room, state.messages);

    broadcast({ type: 'message', room: state.room, message });

    if (message.disappearing) {
        startDisappearingTimer(message.id, message.disappearTime);
    }
}

// ----- Handle Incoming Message -----
function handleIncomingMessage(message) {
    // Check if message already exists
    if (state.messages.find(m => m.id === message.id)) return;

    state.messages.push(message);

    if (message.disappearing && message.userId !== state.userId) {
        // Show placeholder - user must click to view
        renderMessages();
        return;
    }

    renderMessages();
    saveMessages(state.room, state.messages);

    // Notification sound effect (visual feedback)
    if (message.userId !== state.userId) {
        showToast(`${message.user}: ${message.type === 'text' ? message.content.slice(0, 50) : message.type === 'image' ? '📷 Imagem' : '🎤 Áudio'}`, 'info');
    }

    if (message.disappearing && message.userId !== state.userId) {
        // Auto-start disappearing timer after a short delay
        setTimeout(() => {
            startDisappearingTimer(message.id, message.disappearTime);
        }, 2000);
    }
}

// ----- System Messages -----
function addSystemMessage(text) {
    const message = {
        id: generateId(),
        type: 'system',
        content: text,
        timestamp: Date.now()
    };
    state.messages.push(message);
    renderMessages();
}

// ----- Render Messages -----
function renderMessages() {
    const list = document.getElementById('messages-list');
    const empty = document.getElementById('messages-empty');
    const container = document.getElementById('messages-container');

    const chatMessages = state.messages.filter(m => m.type !== 'system');
    const hasMessages = chatMessages.length > 0 || state.messages.some(m => m.type === 'system');

    if (!hasMessages) {
        empty.classList.remove('hidden');
        list.innerHTML = '';
        return;
    }

    empty.classList.add('hidden');
    list.innerHTML = '';

    state.messages.forEach(message => {
        const el = createMessageElement(message);
        if (el) list.appendChild(el);
    });

    // Auto scroll
    container.scrollTop = container.scrollHeight;

    lucide.createIcons();
}

function createMessageElement(message) {
    if (message.type === 'system') {
        const div = document.createElement('div');
        div.className = 'message-system py-2';
        div.id = `msg-${message.id}`;
        div.innerHTML = `<span>${message.content}</span>`;
        return div;
    }

    const isSent = message.userId === state.userId;
    const div = document.createElement('div');
    div.className = `flex ${isSent ? 'justify-end' : 'justify-start'} mb-3`;
    div.id = `msg-${message.id}`;

    // Check if disappearing and not yet viewed by current user
    const isDisappearingHidden = message.disappearing && !isSent && message._hidden;

    const color = getUserColor(message.user);

    let contentHTML = '';

    if (isDisappearingHidden) {
        contentHTML = `
            <div class="bubble-content cursor-pointer" onclick="requestViewDisappearing('${message.id}')">
                <div class="flex items-center gap-2 text-gray-400">
                    <i data-lucide="eye-off" class="w-4 h-4"></i>
                    <span class="text-sm">Mensagem temporária - clique para visualizar</span>
                </div>
            </div>
        `;
    } else if (message.type === 'text') {
        contentHTML = `
            <div class="bubble-content">
                ${!isSent ? `<p class="text-xs font-semibold mb-1" style="color:${color}">${message.user}</p>` : ''}
                <p class="text-sm md:text-base whitespace-pre-wrap">${escapeHtml(message.content)}</p>
                <div class="flex items-center gap-2 mt-1 ${isSent ? 'justify-end' : ''}">
                    <span class="text-[10px] ${isSent ? 'text-white/60' : 'text-gray-500'}">${formatTime(message.timestamp)}</span>
                    ${message.disappearing ? `<span class="disappear-indicator" id="timer-${message.id}"><i data-lucide="timer" class="w-3 h-3"></i>${message.disappearTime}s</span>` : ''}
                </div>
            </div>
        `;
    } else if (message.type === 'image') {
        contentHTML = `
            <div class="bubble-content p-1.5">
                ${!isSent ? `<p class="text-xs font-semibold mb-1 px-2 pt-1" style="color:${color}">${message.user}</p>` : ''}
                <div class="message-image" onclick="openImageViewer('${message.id}')">
                    <img src="${message.content}" alt="Imagem" loading="lazy">
                </div>
                <div class="flex items-center gap-2 mt-1 px-2 ${isSent ? 'justify-end' : ''}">
                    <span class="text-[10px] ${isSent ? 'text-white/60' : 'text-gray-500'}">${formatTime(message.timestamp)}</span>
                    ${message.disappearing ? `<span class="disappear-indicator" id="timer-${message.id}"><i data-lucide="timer" class="w-3 h-3"></i>${message.disappearTime}s</span>` : ''}
                </div>
            </div>
        `;
    } else if (message.type === 'audio') {
        const bars = Array.from({ length: 20 }, () => {
            const h = Math.random() * 20 + 5;
            return `<div class="bar" style="height:${h}px"></div>`;
        }).join('');

        contentHTML = `
            <div class="bubble-content">
                ${!isSent ? `<p class="text-xs font-semibold mb-1" style="color:${color}">${message.user}</p>` : ''}
                <div class="audio-player">
                    <button class="play-btn" onclick="toggleAudio(this, '${message.id}')">
                        <i data-lucide="play" class="w-4 h-4"></i>
                    </button>
                    <div class="flex-1">
                        <div class="audio-waveform" id="waveform-${message.id}">${bars}</div>
                        <span class="text-[10px] ${isSent ? 'text-white/60' : 'text-gray-500'}">${formatDuration(message.duration || 0)}</span>
                    </div>
                </div>
                <div class="flex items-center gap-2 mt-1 ${isSent ? 'justify-end' : ''}">
                    <span class="text-[10px] ${isSent ? 'text-white/60' : 'text-gray-500'}">${formatTime(message.timestamp)}</span>
                    ${message.disappearing ? `<span class="disappear-indicator" id="timer-${message.id}"><i data-lucide="timer" class="w-3 h-3"></i>${message.disappearTime}s</span>` : ''}
                </div>
            </div>
        `;
    }

    div.innerHTML = `
        <div class="message-bubble ${isSent ? 'message-sent' : 'message-received'}">
            ${contentHTML}
        </div>
    `;

    return div;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ----- Disappearing Messages -----
function toggleDisappearing() {
    state.disappearing = !state.disappearing;

    const bar = document.getElementById('disappear-bar');
    const selector = document.getElementById('disappear-selector');
    const btn = document.getElementById('btn-disappear');

    if (state.disappearing) {
        bar.classList.remove('hidden');
        bar.classList.add('flex');
        selector.classList.remove('hidden');
        btn.classList.add('text-amber-400');
        btn.classList.remove('text-gray-500');
        updateDisappearLabel();
    } else {
        bar.classList.add('hidden');
        bar.classList.remove('flex');
        selector.classList.add('hidden');
        btn.classList.remove('text-amber-400');
        btn.classList.add('text-gray-500');
    }
}

function setDisappearTime(seconds) {
    state.disappearTime = seconds;
    updateDisappearLabel();

    document.querySelectorAll('.disappear-time-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.time) === seconds);
    });
}

function updateDisappearLabel() {
    const label = document.getElementById('disappear-timer-label');
    if (state.disappearTime >= 60) {
        label.textContent = `${state.disappearTime / 60}min`;
    } else {
        label.textContent = `${state.disappearTime}s`;
    }
}

function startDisappearingTimer(messageId, seconds) {
    let remaining = seconds;
    const timerEl = () => document.getElementById(`timer-${messageId}`);

    const interval = setInterval(() => {
        remaining--;
        const el = timerEl();
        if (el) {
            el.innerHTML = `<i data-lucide="timer" class="w-3 h-3"></i>${remaining}s`;
            el.classList.add('timer-active');
            lucide.createIcons({ nodes: [el] });
        }

        if (remaining <= 0) {
            clearInterval(interval);
            removeMessage(messageId);
        }
    }, 1000);
}

function removeMessage(messageId) {
    state.messages = state.messages.filter(m => m.id !== messageId);
    const el = document.getElementById(`msg-${messageId}`);
    if (el) {
        el.style.transition = 'all 0.3s ease';
        el.style.opacity = '0';
        el.style.transform = 'scale(0.8)';
        setTimeout(() => el.remove(), 300);
    }
    saveMessages(state.room, state.messages);
}

function requestViewDisappearing(messageId) {
    state.pendingDisappearingMsg = messageId;
    const modal = document.getElementById('disappear-modal');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    lucide.createIcons();
}

function viewDisappearingMessage() {
    const messageId = state.pendingDisappearingMsg;
    if (!messageId) return;

    const message = state.messages.find(m => m.id === messageId);
    if (message) {
        message._hidden = false;
        message.viewed = true;
        renderMessages();

        // Start disappearing timer
        startDisappearingTimer(messageId, message.disappearTime);

        // Broadcast viewed
        broadcast({ type: 'viewed', room: state.room, messageId });
    }

    cancelDisappearingView();
}

function cancelDisappearingView() {
    state.pendingDisappearingMsg = null;
    const modal = document.getElementById('disappear-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

function handleMessageViewed(messageId) {
    const message = state.messages.find(m => m.id === messageId);
    if (message && message.disappearing) {
        startDisappearingTimer(messageId, message.disappearTime);
    }
}

// ----- Image Upload -----
function handleImageSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showToast('Selecione apenas arquivos de imagem', 'error');
        return;
    }

    if (file.size > CONFIG.MAX_IMAGE_SIZE) {
        showToast('Imagem muito grande. Máximo 5MB.', 'error');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        // Resize image
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let { width, height } = img;

            if (width > CONFIG.MAX_IMAGE_DIMENSION || height > CONFIG.MAX_IMAGE_DIMENSION) {
                if (width > height) {
                    height = (height / width) * CONFIG.MAX_IMAGE_DIMENSION;
                    width = CONFIG.MAX_IMAGE_DIMENSION;
                } else {
                    width = (width / height) * CONFIG.MAX_IMAGE_DIMENSION;
                    height = CONFIG.MAX_IMAGE_DIMENSION;
                }
            }

            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            const dataUrl = canvas.toDataURL('image/jpeg', CONFIG.IMAGE_QUALITY);

            state.selectedImage = {
                data: dataUrl,
                name: file.name,
                size: file.size
            };

            // Show preview
            document.getElementById('image-preview-bar').classList.remove('hidden');
            document.getElementById('image-preview-thumb').src = dataUrl;
            document.getElementById('image-preview-name').textContent = file.name;
            document.getElementById('image-preview-size').textContent = formatFileSize(file.size);
        };
        img.src = e.target.result;
    };
    reader.readAsDataURL(file);

    // Reset input
    event.target.value = '';
}

function cancelImage() {
    state.selectedImage = null;
    document.getElementById('image-preview-bar').classList.add('hidden');
}

// ----- Image Viewer -----
function openImageViewer(messageId) {
    const message = state.messages.find(m => m.id === messageId);
    if (!message || message.type !== 'image') return;

    const viewer = document.getElementById('image-viewer');
    document.getElementById('image-viewer-img').src = message.content;
    viewer.classList.remove('hidden');
    viewer.classList.add('flex');
}

function closeImageViewer(event) {
    if (event && event.target !== event.currentTarget && !event.target.closest('button')) return;
    const viewer = document.getElementById('image-viewer');
    viewer.classList.add('hidden');
    viewer.classList.remove('flex');
}

// ----- Audio Recording -----
async function startRecording() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        state.mediaRecorder = new MediaRecorder(stream);
        state.audioChunks = [];
        state.recordingSeconds = 0;

        state.mediaRecorder.ondataavailable = (event) => {
            state.audioChunks.push(event.data);
        };

        state.mediaRecorder.onstop = () => {
            const blob = new Blob(state.audioChunks, { type: 'audio/webm' });
            const reader = new FileReader();
            reader.onload = (e) => {
                sendAudioMessage({
                    data: e.target.result,
                    duration: state.recordingSeconds
                });
            };
            reader.readAsDataURL(blob);

            // Stop all tracks
            stream.getTracks().forEach(track => track.stop());
        };

        state.mediaRecorder.start();

        // Show recording bar
        document.getElementById('recording-bar').classList.remove('hidden');
        document.getElementById('recording-bar').classList.add('flex');
        document.getElementById('btn-audio').classList.add('text-red-400');

        // Timer
        state.recordingInterval = setInterval(() => {
            state.recordingSeconds++;
            document.getElementById('recording-time').textContent = formatDuration(state.recordingSeconds);
        }, 1000);

    } catch (err) {
        showToast('Não foi possível acessar o microfone', 'error');
        console.error(err);
    }
}

function stopRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
        state.mediaRecorder.stop();
    }

    clearInterval(state.recordingInterval);
    document.getElementById('recording-bar').classList.add('hidden');
    document.getElementById('recording-bar').classList.remove('flex');
    document.getElementById('btn-audio').classList.remove('text-red-400');

    showToast('Áudio enviado!', 'success');
}

function cancelRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
        state.mediaRecorder.stop();
        // Don't send - just discard
        state.mediaRecorder.onstop = () => {
            state.mediaRecorder.stream.getTracks().forEach(track => track.stop());
        };
    }

    clearInterval(state.recordingInterval);
    document.getElementById('recording-bar').classList.add('hidden');
    document.getElementById('recording-bar').classList.remove('flex');
    document.getElementById('btn-audio').classList.remove('text-red-400');
}

// ----- Audio Playback -----
const audioPlayers = {};

function toggleAudio(button, messageId) {
    const message = state.messages.find(m => m.id === messageId);
    if (!message || message.type !== 'audio') return;

    if (audioPlayers[messageId]) {
        const audio = audioPlayers[messageId];
        if (audio.paused) {
            audio.play();
            button.innerHTML = '<i data-lucide="pause" class="w-4 h-4"></i>';
            lucide.createIcons({ nodes: [button] });
        } else {
            audio.pause();
            button.innerHTML = '<i data-lucide="play" class="w-4 h-4"></i>';
            lucide.createIcons({ nodes: [button] });
        }
        return;
    }

    const audio = new Audio(message.content);
    audioPlayers[messageId] = audio;

    audio.onplay = () => {
        button.innerHTML = '<i data-lucide="pause" class="w-4 h-4"></i>';
        lucide.createIcons({ nodes: [button] });
        animateWaveform(messageId, audio);
    };

    audio.onpause = () => {
        button.innerHTML = '<i data-lucide="play" class="w-4 h-4"></i>';
        lucide.createIcons({ nodes: [button] });
    };

    audio.onended = () => {
        button.innerHTML = '<i data-lucide="play" class="w-4 h-4"></i>';
        lucide.createIcons({ nodes: [button] });
        delete audioPlayers[messageId];
    };

    audio.play().catch(() => {
        showToast('Erro ao reproduzir áudio', 'error');
    });
}

function animateWaveform(messageId, audio) {
    const waveform = document.getElementById(`waveform-${messageId}`);
    if (!waveform) return;

    const bars = waveform.querySelectorAll('.bar');
    const animate = () => {
        if (audio.paused) return;
        bars.forEach(bar => {
            const h = Math.random() * 25 + 5;
            bar.style.height = h + 'px';
            bar.style.background = 'rgba(255,255,255,0.7)';
        });
        requestAnimationFrame(animate);
    };
    animate();
}

// ----- Clear Chat (Owner) -----
function handleClearChat() {
    if (!state.isOwner) {
        showToast('Apenas o dono da sala pode limpar o chat', 'error');
        return;
    }

    if (confirm('Tem certeza que deseja limpar todo o histórico do chat? Esta ação não pode ser desfeita.')) {
        state.messages = [];
        renderMessages();
        saveMessages(state.room, state.messages);

        broadcast({ type: 'clear', room: state.room });
        showToast('Histórico do chat limpo', 'success');
    }
}

// ----- Keyboard Shortcuts -----
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeImageViewer();
        cancelDisappearingView();
    }
});

// ----- Page Visibility -----
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Page is hidden
    } else {
        // Page is visible again - refresh data
        if (state.room) {
            // Check for new messages in localStorage
            const storedMessages = loadMessages(state.room);
            if (storedMessages.length > state.messages.filter(m => m.type !== 'system').length) {
                state.messages = [...state.messages.filter(m => m.type === 'system'), ...storedMessages];
                renderMessages();
            }
        }
    }
});

// ----- Before Unload -----
window.addEventListener('beforeunload', () => {
    if (state.room && state.userId) {
        broadcast({
            type: 'user-leave',
            room: state.room,
            userId: state.userId,
            userName: state.user
        });

        // Clean up if last user
        state.onlineUsers.delete(state.userId);
        if (state.onlineUsers.size === 0) {
            removeRoomData(state.room);
        }
    }
    stopHeartbeat();
    stopUserCheck();
});

// ----- Initialization -----
function init() {
    lucide.createIcons();

    // Handle room type buttons initial state
    document.querySelectorAll('.room-type-btn').forEach(btn => {
        btn.classList.toggle('active', btn.querySelector('input').checked);
    });
}

init();