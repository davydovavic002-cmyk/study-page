window.applyLibPos = null;
window.renderLibraryFolders = null;
window.renderLibrarySubFolders = null;
window.renderLibraryCategory = null;

document.addEventListener('DOMContentLoaded', async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomCode = urlParams.get('room');
    if (!roomCode) { window.location.href = '/lobby.html'; return; }

    let user, crBoard = null, isTeacher = false;
    let tabs = [{ id: 'play', type: 'play', fen: 'start', shapes: [], pgn: '', customHistory: [] }];
    let activeTabId = 'play';
    let editorBoard = null;
    let allLibraryPositions = [];

    // --- ИСПРАВЛЕННЫЕ СТИЛИ: ТОЛЬКО ДЛЯ РЕДАКТОРА ---
    const style = document.createElement('style');
    style.innerHTML = `
        #editor-modal .modal-content {
            max-height: 95vh;
            display: flex;
            flex-direction: column;
            padding: 15px;
            overflow-y: auto;
        }
        /* Уменьшаем только доску редактора, чтобы влезли кнопки */
        #editor-modal #board-editor {
            width: 320px !important;
            height: 320px !important;
            max-width: 100%;
            margin: 0 auto;
        }
        #editor-modal .modal-footer {
            margin-top: 10px;
            display: flex;
            justify-content: center;
            gap: 10px;
            flex-wrap: wrap;
        }
    `;
    document.head.appendChild(style);

    // --- АУТЕНТИФИКАЦИЯ ---
    try {
        const res = await fetch('/api/profile');
        if (!res.ok) throw new Error();
        user = await res.json();
        document.getElementById('user-status').innerHTML = `Вы: <strong>${user.username}</strong>`;
    } catch (e) { window.location.href = '/'; return; }

    const socket = io({ transports: ['websocket'], withCredentials: true });

    // --- ИНИЦИАЛИЗАЦИЯ ОСНОВНОЙ ДОСКИ ---
    crBoard = new ChessradBoard('myBoard', {
        mode: 'game',
        onMove: (moveData) => {
            handleMove(moveData);
        }
    });

    function handleMove(moveData) {
        const tab = tabs.find(t => t.id === activeTabId);
        if (!tab) return;

        if (!tab.customHistory) tab.customHistory = [];

        tab.customHistory.push({
            san: moveData.san,
            fen: moveData.fen
        });
        tab.fen = moveData.fen;
        tab.pgn = moveData.pgn;

        socket.emit('study:move', {
            roomCode,
            tabId: activeTabId,
            fen: tab.fen,
            pgn: tab.pgn,
            customHistory: tab.customHistory
        });
        updateUI();
    }

    // --- КЛИКАБЕЛЬНАЯ ИСТОРИЯ ---
    window.goToMove = (index) => {
        if (!isTeacher) return;
        const tab = tabs.find(t => t.id === activeTabId);
        if (!tab || !tab.customHistory || !tab.customHistory[index]) return;

        const target = tab.customHistory[index];
        tab.customHistory = tab.customHistory.slice(0, index + 1);
        tab.fen = target.fen;

        crBoard.setPosition(target.fen);

        socket.emit('study:move', {
            roomCode,
            tabId: activeTabId,
            fen: tab.fen,
            pgn: tab.pgn,
            customHistory: tab.customHistory
        });
        updateUI();
    };

    window.resetFullHistory = () => {
        if (!isTeacher) return;
        const tab = tabs.find(t => t.id === activeTabId);
        if (!tab) return;

        const initialFen = (tab.id === 'play') ? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' : '8/8/8/8/8/8/8/8 w - - 0 1';

        tab.customHistory = [];
        tab.fen = initialFen;
        tab.pgn = '';

        crBoard.setPosition(initialFen);

        socket.emit('study:move', {
            roomCode,
            tabId: activeTabId,
            fen: initialFen,
            pgn: '',
            customHistory: []
        });
        updateUI();
    };

    // --- УПРАВЛЕНИЕ ВКЛАДКАМИ ---
    document.getElementById('add-tab-btn').onclick = () => {
        if (!isTeacher) return;
        const newId = 'tab_' + Date.now();
        const startFen = '8/8/8/8/8/8/8/8 w - - 0 1';
        tabs.push({
            id: newId, type: 'demo', fen: startFen, shapes: [], customHistory: []
        });
        socket.emit('study:updateTabs', { roomCode, tabs, activeTabId: newId });
        window.switchTab(newId);
    };

    window.removeTab = (id, event) => {
        if (event) event.stopPropagation();
        if (!isTeacher || id === 'play') return;
        tabs = tabs.filter(t => t.id !== id);
        if (activeTabId === id) activeTabId = 'play';
        socket.emit('study:updateTabs', { roomCode, tabs, activeTabId });
        window.switchTab(activeTabId);
    };

    window.switchTab = (id) => {
        const tab = tabs.find(t => t.id === id);
        if (!tab) return;
        activeTabId = id;

        crBoard.mode = (tab.type === 'play') ? 'game' : 'demo';
        crBoard.setPosition(tab.fen === 'start' ? 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' : tab.fen);

        if (tab.type === 'play' && !isTeacher) {
            crBoard.setOrientation('black');
        } else {
            crBoard.setOrientation('white');
        }

        crBoard.shapes = tab.shapes || [];
        crBoard.drawMarkup();

        if (isTeacher) socket.emit('study:switchTab', { roomCode, tabId: id });
        updateUI();
    };

    // --- БИБЛИОТЕКА ---
    document.getElementById('lib-btn').onclick = async () => {
        const res = await fetch('/api/positions');
        allLibraryPositions = await res.json();
        document.getElementById('lib-modal').style.display = 'flex';
        window.renderLibraryFolders();
    };

    window.renderLibraryFolders = () => {
        const content = document.getElementById('lib-content');
        const bigFolders = [...new Set(allLibraryPositions.map(p => p.big_folder || 'Без раздела'))].sort();
        content.innerHTML = bigFolders.map(bf => `
            <div class="folder-card" onclick="window.renderLibrarySubFolders('${bf}')">
                <div class="folder-icon">📁</div>
                <strong>${bf}</strong>
            </div>`).join('');
    };

    window.renderLibrarySubFolders = (big) => {
        const content = document.getElementById('lib-content');
        const filtered = allLibraryPositions.filter(p => (p.big_folder || 'Без раздела') === big);
        const categories = [...new Set(filtered.map(p => p.category || 'Общее'))].sort();
        content.innerHTML = `<div class="lib-nav-back"><button onclick="window.renderLibraryFolders()">← Назад</button></div>`;
        content.innerHTML += categories.map(cat => `
            <div class="folder-card subfolder" onclick="window.renderLibraryCategory('${big}', '${cat}')">
                <div class="folder-icon">📂</div>
                <strong>${cat}</strong>
            </div>`).join('');
    };

    window.renderLibraryCategory = (big, cat) => {
        const positions = allLibraryPositions.filter(p => p.big_folder === big && p.category === cat);
        const content = document.getElementById('lib-content');
        content.innerHTML = `<div class="lib-nav-back"><button onclick="window.renderLibrarySubFolders('${big}')">← Назад</button></div>`;

        positions.forEach(pos => {
            const boardId = `lib-mini-${pos.id}`;
            const div = document.createElement('div');
            div.className = 'lib-pos-card';
            div.innerHTML = `<div id="${boardId}" style="width:140px;height:140px;"></div><div class="mini-title">${pos.title}</div>`;
            div.onclick = () => window.applyLibPos(pos.fen);
            content.appendChild(div);

            setTimeout(() => {
                new ChessradBoard(boardId, { mode: 'demo' }).setPosition(pos.fen);
            }, 10);
        });
    };

    window.applyLibPos = (fen) => {
        const tab = tabs.find(t => t.id === activeTabId);
        if (!tab) return;
        tab.fen = fen;
        tab.customHistory = [];
        crBoard.setPosition(fen);
        socket.emit('study:move', { roomCode, tabId: activeTabId, fen, pgn: '', customHistory: [] });
        document.getElementById('lib-modal').style.display = 'none';
        updateUI();
    };

    // --- РЕДАКТОР ПОЗИЦИИ ---

// --- РЕДАКТОР ПОЗИЦИИ ---
document.getElementById('editor-btn').onclick = () => {
    document.getElementById('editor-modal').style.display = 'flex';
    const currentFen = crBoard.game.fen();

    setTimeout(() => {
        if (!editorBoard) {
            editorBoard = new ChessradBoard('board-editor', {
                mode: 'editor',
                sparePieces: true,
                pieceTheme: '/img/chesspieces/wikipedia/{piece}.png'
            });
        }
        editorBoard.setPosition(currentFen);

        // КЛЮЧЕВОЙ МОМЕНТ: принудительно пересчитываем размеры
        if (editorBoard.board && typeof editorBoard.board.resize === 'function') {
            editorBoard.board.resize();
        } else if (typeof editorBoard.resize === 'function') {
            editorBoard.resize();
        }
    }, 250); // Увеличили задержку до 250мс для стабильности
};

    document.getElementById('editor-clear-btn').onclick = () => {
        if (editorBoard) editorBoard.setPosition('8/8/8/8/8/8/8/8 w - - 0 1');
    };

    document.getElementById('editor-start-btn').onclick = () => {
        if (editorBoard) editorBoard.setPosition('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    };

    document.getElementById('apply-editor-btn').onclick = () => {
        if (editorBoard) {
            const fen = editorBoard.game.fen();
            window.applyLibPos(fen);
            document.getElementById('editor-modal').style.display = 'none';
        }
    };

    // --- ОБНОВЛЕНИЕ UI ---
    function updateUI() {
        const historyBlock = document.getElementById('moves-history-block');
        const demoBlock = document.getElementById('demo-controls-block');
        const statusMsg = document.getElementById('status-msg');
        const tab = tabs.find(t => t.id === activeTabId);

        if (!tab) return;

        demoBlock.style.display = (isTeacher && tab.type !== 'play') ? 'flex' : 'none';

        const turn = crBoard.game.turn() === 'w' ? 'Белых' : 'Черных';
        statusMsg.innerHTML = tab.type === 'play'
            ? `<span style="color: #2ecc71;">● ХОД ${turn.toUpperCase()}</span>`
            : `<span style="color: #3498db;">● РЕЖИМ ДЕМОНСТРАЦИИ</span>`;

        const history = tab.customHistory || [];
        const pieceNames = { 'K': 'король', 'Q': 'ферзь', 'R': 'ладья', 'B': 'слон', 'N': 'конь' };

        const formatSan = (san) => {
            if (!san) return "";
            let cleanSan = san.replace('forced', '').trim();
            if (cleanSan === "") return "ход";

            if (cleanSan.includes('O-O-O')) return 'длинная рокировка';
            if (cleanSan.includes('O-O')) return 'короткая рокировка';

            // Проверяем первую букву. Если это K, Q, R, B или N — это фигура.
            const firstChar = cleanSan[0];
            if (pieceNames[firstChar]) {
                const coords = cleanSan.substring(1).replace('x', ' '); // Убираем 'x' для красоты
                return `${pieceNames[firstChar]} ${coords}`;
            }

            // Если первой буквы нет в списке фигур, значит это пешка (например, "e4" или "dxc5")
            return `пешка ${cleanSan}`;
        };

        if (history.length > 0) {
            let html = '<div class="pgn-container">';
            if (isTeacher) html += `<span class="pgn-reset-btn" onclick="window.resetFullHistory()"><i class="fas fa-times-circle"></i></span>`;

            for (let i = 0; i < history.length; i += 2) {
                const moveNum = Math.floor(i / 2) + 1;
                const isWActive = history[i].fen === crBoard.game.fen();
                const isBActive = history[i+1] && history[i+1].fen === crBoard.game.fen();

                html += `<div class="move-row">
                    <span class="move-number">${moveNum}.</span>
                    <span class="pgn-move ${isWActive ? 'active-move' : ''}" onclick="goToMove(${i})">${formatSan(history[i].san)}</span>
                    ${history[i+1] ? `<span class="pgn-move ${isBActive ? 'active-move' : ''}" onclick="goToMove(${i+1})">${formatSan(history[i+1].san)}</span>` : ''}
                </div>`;
            }
            historyBlock.innerHTML = html + '</div>';
        } else {
            historyBlock.innerHTML = '<em>История пуста</em>';
        }
        renderTabs();
    }

    function renderTabs() {
        const tabsList = document.getElementById('tabs-list');
        tabsList.innerHTML = tabs.map(t => `
            <div class="tab-item ${t.id === activeTabId ? 'active' : ''}" onclick="window.switchTab('${t.id}')">
                <i class="fas ${t.type === 'play' ? 'fa-gamepad' : 'fa-chalkboard'}"></i>
                <span class="tab-label">${t.type === 'play' ? 'Игра' : 'Демо'}</span>
                ${isTeacher && t.id !== 'play' ? `<div class="delete-tab" onclick="window.removeTab('${t.id}', event)"><i class="fas fa-times"></i></div>` : ''}
            </div>
        `).join('');
    }

    // --- СОКЕТЫ ---
    socket.emit('study:join', { roomCode });

    socket.on('study:roomData', (d) => {
        isTeacher = (Number(d.teacher_id) === Number(user.id) || user.role === 'teacher' || user.role === 'admin');
        document.getElementById('teacher-tools').style.display = isTeacher ? 'flex' : 'none';
        document.getElementById('add-tab-btn').style.display = isTeacher ? 'block' : 'none';
        if (d.tabs) tabs = d.tabs;
        window.switchTab(d.activeTabId || 'play');
    });

    socket.on('study:syncMove', (d) => {
        const t = tabs.find(x => x.id === d.tabId);
        if (t) {
            t.fen = d.fen;
            t.customHistory = d.customHistory || [];
            if (d.tabId === activeTabId) {
                crBoard.setPosition(d.fen);
                updateUI();
            }
        }
    });

    socket.on('study:syncDraw', (d) => {
        const t = tabs.find(x => x.id === d.tabId);
        if (t) t.shapes = d.shapes || [];
        if (d.tabId === activeTabId) {
            crBoard.shapes = d.shapes || [];
            crBoard.drawMarkup();
        }
    });

    socket.on('study:syncTabs', (d) => {
        tabs = d.tabs;
        renderTabs();
    });

    socket.on('study:syncSwitchTab', (d) => {
        if (!isTeacher) window.switchTab(d.tabId);
    });

    const boardEl = document.getElementById('myBoard');

    boardEl.addEventListener('mousedown', (e) => {
        if (!isTeacher) return;
        if (e.button === 0) {
            crBoard.shapes = [];
            crBoard.drawMarkup();
            socket.emit('study:draw', { roomCode, tabId: activeTabId, shapes: [] });
        }
    });

    boardEl.addEventListener('mouseup', () => {
        if (isTeacher) {
            setTimeout(() => {
                socket.emit('study:draw', { roomCode, tabId: activeTabId, shapes: crBoard.shapes });
            }, 50);
        }
    });

    document.getElementById('flip-btn').onclick = () => {
        crBoard.setOrientation(crBoard.orientation === 'white' ? 'black' : 'white');
    };
});
