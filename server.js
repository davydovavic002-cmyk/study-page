// ---------------------------------
// 1. ИМПОРТЫ И НАСТРОЙКА
// ---------------------------------
import 'dotenv/config';
import express from 'express';
import http from 'http';
import https from 'https';
import fs from 'fs';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import cookie from 'cookie';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import { Chess } from 'chess.js'; // Добавили импорт для проверки ходов на сервере
import session from 'express-session'; // или const session = require('express-session');
import sqliteStore from 'connect-sqlite3';

import {
    db,
    initDb,
    addUser,
    findUserByUsername,
    findUserById,
    updateUserStats,
    createStudyRoom,
    findStudyRoomByCode,
    joinStudentToRoom,
    updateStudyRoomFen,
    getTeacherRooms,
getNextPuzzleForUser,
    solvePuzzleUpdate,
    deleteStudyRoom,
    // --- НОВЫЕ ФУНКЦИИ ДЛЯ ПАЗЛОВ ---
    initPuzzlesTable,
getSolvedCountToday,
    completeDailyPuzzles,
    restoreStreak    // Для стрика (10 задач)
} from './db.js';
import { Game } from './gamelogic.js';
import { Tournament } from './tournament.js';

const app = express();

// ОПРЕДЕЛЯЕМ ПУТИ
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicPath = path.join(__dirname, 'public');
const nodeModulesPath = path.join(__dirname, 'node_modules');

console.log('--- Debug Paths ---');
console.log('Public path:', publicPath);
console.log('Node modules path:', nodeModulesPath);
console.log('-------------------');

// РАЗДАЕМ СТАТИКУ (Важен порядок!)
app.use(express.static(publicPath));
app.use('/node_modules', express.static(nodeModulesPath));

const corsOptions = {
    origin: (origin, callback) => {
        // Разрешаем запросы с твоего домена
        if (!origin || origin.includes('chessrad.app')) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true
};

// 1. Позволяем серверу отдавать статику из public
app.use(express.static(path.join(__dirname, 'public')));

// 2. ВАЖНО: Пробрасываем папку node_modules, чтобы браузер нашел Chessground
app.use('/node_modules', express.static(path.join(__dirname, 'node_modules')));

app.use(cors(corsOptions));

// Создаем ОДИН сервер для всего (API + Sockets)
const httpServer = http.createServer(app);

// Привязываем сокеты к этому серверу
const io = new Server(httpServer, {
    cors: corsOptions
});

const SQLiteStore = sqliteStore(session);
app.set('trust proxy', 1); // Позволяет Express доверять Nginx и передавать Cookie

// Защита от слишком частых запросов (регистрация/логин)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 20, // Лимит 20 запросов с одного IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Слишком много попыток. Попробуйте позже." }
});

app.use(session({
    // Указываем SQLite в качестве хранилища
    store: new SQLiteStore({
        db: 'chess-app.db',    // Имя твоей базы
        dir: './db'            // Папка, где она лежит
    }),
    secret: 'chess-secret-key',
    resave: false,
    saveUninitialized: false, // Ставим false, чтобы не плодить пустые сессии
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        secure: true
    }
}));
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-if-env-missing';


// ---------------------------------
// 2. ГЛОБАЛЬНОЕ СОСТОЯНИЕ СЕРВЕРА
// ---------------------------------
const activeGames = new Map();
const onlineUsers = new Map();
const matchmakingQueue = [];

let mainTournament;

function createAndAssignTournament() {
    mainTournament = new Tournament({
        io: io,
        games: activeGames,
        id: 'main-tournament-1',
        name: 'Главный еженедельный турнир',
    });
}

createAndAssignTournament();

app.get('/reset-tournament', (req, res) => {
    createAndAssignTournament();
    io.emit('tournament:stateUpdate', mainTournament.getState());
    res.redirect('/tournament.html');
});

// ---------------------------------
// 3. MIDDLEWARE
// ---------------------------------

// ---------------------------------
// 3. MIDDLEWARE
// ---------------------------------
app.use(express.json());
app.use(cookieParser());


app.use((req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');

res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://code.jquery.com https://unpkg.com; " +
        "worker-src 'self' blob:; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com https://cdnjs.cloudflare.com; " +
        "font-src 'self' data: https://fonts.gstatic.com https://fonts.googleapis.com https://cdnjs.cloudflare.com; " +
        "img-src 'self' data: https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; " +
        "connect-src 'self' wss://chessrad.app https://chessrad.app https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;"
    );

    next();
});
// ---------------------------------
// 4. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ---------------------------------
const authenticateToken = (req, res, next) => {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ message: 'Доступ запрещен' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ message: 'Недействительный токен' });
        req.user = user;
        next();
    });
};

const requireAdmin = async (req, res, next) => {
    try {
        const user = await findUserById(req.user.id);
        if (user && user.role === 'admin') {
            next();
        } else {
            res.status(403).json({ message: 'Требуются права администратора' });
        }
    } catch (e) {
        res.status(500).json({ message: 'Ошибка проверки прав' });
    }
};

async function comparePasswords(password, hash) {
    try { return await bcrypt.compare(password, hash); }
    catch (error) { return false; }
}

async function handleGameResultUpdate(winnerId, loserId, isDraw) {
    try {
        await updateUserStats(winnerId, loserId, isDraw);
    } catch (error) {
        console.error('[Stats] Ошибка обновления статистики:', error);
    }
}

function createAndStartGame(player1Socket, player2Socket) {
    if (!player1Socket.user || !player2Socket.user) {
        console.error('❌ Ошибка: Попытка создать игру для неавторизованных сокетов');
        return;
    }

    const isPlayer1White = Math.random() < 0.5;
    const white = isPlayer1White ? player1Socket : player2Socket;
    const black = isPlayer1White ? player2Socket : player1Socket;

    const game = new Game({
        io: io,
        playerWhite: { socket: white, user: white.user },
        playerBlack: { socket: black, user: black.user },
        onGameResult: handleGameResultUpdate,
        onGameEnd: (gameId) => activeGames.delete(gameId)
    });

    activeGames.set(game.getId(), game);
    game.start();
}

// ---------------------------------
// 5. API РОУТЫ
// ---------------------------------

app.post('/api/register', authLimiter, async (req, res) => {
    let { username, password, role } = req.body;
    if (username) username = username.replace(/<\/?[^>]+(>|$)/g, "").trim();

    if (!username || !password || password.length < 4) {
        return res.status(400).json({ message: 'Ошибка валидации' });
    }

    try {
        const existingUser = await findUserByUsername(username);
        if (existingUser) return res.status(409).json({ message: 'Пользователь существует' });

        const userRole = (role === 'teacher') ? 'teacher' : 'student';
        await addUser(username, password, userRole);

        res.status(201).json({ message: 'Успех' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await findUserByUsername(username);

        // 1. Безопасная проверка пароля
        if (!user || !(await comparePasswords(password, user.password_hash))) {
            return res.status(401).json({ success: false, message: 'Неверные данные' });
        }

        // 2. Генерация токена
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '1d' }
        );

        // 3. Установка Cookie
        res.cookie('token', token, {
            httpOnly: true,
            maxAge: 86400000, // 24 часа
            sameSite: 'Lax',
            secure: true, // Включай только если есть HTTPS, иначе кука не придет!
            path: '/'
        });

        // 4. Возвращаем важные флаги и данные
        res.status(200).json({
            success: true,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                // Передаем флаг принудительной смены пароля
                mustChangePassword: !!user.must_change_password
            }
        });
    } catch (e) {
        console.error('Login error:', e);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});
app.get('/api/profile', authenticateToken, async (req, res) => {
    try {
        const user = await findUserById(req.user.id);
        if (!user) return res.status(404).json({ message: 'Пользователь не найден' });
        const { password_hash, ...profileData } = user;
        res.json(profileData);
    } catch (e) {
        res.status(500).json({ message: 'Ошибка сервера при загрузке профиля' });
    }
});

app.post('/api/profile/change-password', authenticateToken, async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const userId = req.user.id;

        if (!newPassword || newPassword.length < 6) {
            return res.status(400).json({ message: 'Пароль слишком короткий' });
        }

        const user = await findUserById(userId);

        // Проверяем старый (временный) пароль
        const match = await bcrypt.compare(oldPassword, user.password_hash);
        if (!match) {
            return res.status(401).json({ message: 'Текущий или временный пароль неверный' });
        }

        // Хешируем новый пароль
        const saltRounds = 10;
        const newHash = await bcrypt.hash(newPassword, saltRounds);

        // Вызываем обновление.
        // ВАЖНО: В db.js функция должна ставить must_change_password = 0
        const { updateOwnPassword } = await import('./db.js');
        await updateOwnPassword(userId, newHash);

        res.json({ success: true, message: 'Пароль успешно обновлен' });
    } catch (e) {
        console.error('Ошибка смены пароля:', e);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

app.get('/game/:gameId', authenticateToken, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tournament-game.html'));
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
});

app.get('/lobby', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'lobby.html'));
});

// --- АДМИН-ПАНЕЛЬ ---

app.get('/admin', authenticateToken, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const sortMode = req.query.sort || 'new';
        const { getAllUsers } = await import('./db.js');
        const users = await getAllUsers(sortMode);
        res.json({ success: true, users });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/update-role', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { userId, newRole } = req.body;
        const { updateUserRole } = await import('./db.js');
        await updateUserRole(userId, newRole);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.delete('/api/admin/delete-user/:userId', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { deleteUser } = await import('./db.js');
        await deleteUser(req.params.userId);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/admin/reset-password', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { userId, newPassword } = req.body;
        if (!newPassword || newPassword.length < 4) {
            return res.status(400).json({ success: false, message: 'Пароль короткий' });
        }
        const { resetUserPassword } = await import('./db.js');
        await resetUserPassword(userId, newPassword);
        res.json({ success: true, message: 'Пароль сброшен' });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

// --- ОБУЧЕНИЕ ---

app.post('/api/study/create', authenticateToken, async (req, res) => {
    try {
        const user = await findUserById(req.user.id);
        if (user.role !== 'teacher' && user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Нужна роль учителя' });
        }
        const { countTeacherRooms } = await import('./db.js');
        const roomCount = await countTeacherRooms(user.id);
        if (roomCount >= 5) {
            return res.status(429).json({ success: false, message: 'Лимит комнат' });
        }
        const roomCode = 'CH-' + Math.random().toString(36).substring(2, 7).toUpperCase();
        await createStudyRoom(user.id, roomCode);
        res.json({ success: true, roomCode });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/study/join', authenticateToken, async (req, res) => {
    try {
        const { roomCode } = req.body;
        const room = await findStudyRoomByCode(roomCode);
        if (!room) return res.status(404).json({ success: false });
        if (room.teacher_id !== req.user.id) {
            await joinStudentToRoom(roomCode, req.user.id);
        }
        res.json({ success: true, roomCode });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/study/my-rooms', authenticateToken, async (req, res) => {
    try {
        const rooms = await getTeacherRooms(req.user.id);
        res.json({ success: true, rooms: rooms || [] });
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.delete('/api/study/:roomCode', authenticateToken, async (req, res) => {
    try {
        const result = await deleteStudyRoom(req.params.roomCode, req.user.id);
        if (result && result.changes > 0) {
            res.json({ success: true });
        } else {
            res.status(403).json({ success: false });
        }
    } catch (e) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/positions', authenticateToken, async (req, res) => {
    try {
        const { getTeacherPositions } = await import('./db.js');
        const positions = await getTeacherPositions();
        res.json(positions);
    } catch (e) {
        res.status(500).json({ message: 'Ошибка при получении библиотеки' });
    }
});

app.post('/api/positions', authenticateToken, async (req, res) => {
    try {
        // Добавляем big_folder в деструктуризацию
        const { title, big_folder, category, fen } = req.body;
        if (!title || !fen) return res.status(400).json({ message: 'Данные обязательны' });

        const { addPosition } = await import('./db.js');
        // Передаем big_folder в функцию БД
        await addPosition(req.user.id, title, category, fen, big_folder);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: 'Ошибка при добавлении' });
    }
});
app.delete('/api/positions/:id', authenticateToken, async (req, res) => {
    try {
        const { deletePosition } = await import('./db.js');
        await deletePosition(req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ message: 'Ошибка при удалении' });
    }
});

app.put('/api/positions/:id', authenticateToken, async (req, res) => {
    try {
        const positionId = req.params.id;
        const { title, big_folder, category, fen } = req.body; // Добавляем big_folder
        const { updatePosition } = await import('./db.js');

        // В объекте данных передаем big_folder
        const result = await updatePosition(positionId, null, { title, big_folder, category, fen });

        if (result && result.changes > 0) {
            res.json({ success: true });
        } else {
            res.status(404).json({ success: false, message: 'Позиция не найдена' });
        }
    } catch (e) {
        res.status(500).json({ message: 'Ошибка при обновлении' });
    }
});
app.post('/api/positions/reorder', async (req, res) => {
    const { positions } = req.body;
    try {
        await db.run('BEGIN TRANSACTION');
        for (let item of positions) {
            // Убираем teacher_id, так как база общая
            await db.run(
                'UPDATE position_library SET order_index = ? WHERE id = ?',
                [item.order_index, item.id]
            );
        }
        await db.run('COMMIT');
        res.sendStatus(200);
    } catch (err) {
        await db.run('ROLLBACK');
        res.status(500).send(err.message);
    }
});
// --- API ДЛЯ ТРЕНАЖЕРА И СТРИКОВ ---

// --- ОБНОВЛЕННОЕ API ДЛЯ ТРЕНАЖЕРА ---

// --- ОБНОВЛЕННОЕ API ДЛЯ ТРЕНАЖЕРА ---

// 0. Сброс офсета сессии

// ---------------------------------
// API ДЛЯ ТРЕНАЖЕРА (Интеграция с db.js)
// ---------------------------------

// 0. Сброс офсета сессии (оставляем, так как это логика сессии, а не БД)
app.post('/api/puzzle/reset-session', authenticateToken, (req, res) => {
    req.session.puzzleOffset = 0;
    res.json({ success: true });
});

// 1. Статус для Лобби
// 1. Статус для Лобби
app.get('/api/user/puzzle-status', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;

        // ДИНАМИЧЕСКИЙ ИМПОРТ (как в твоих рабочих апи с positions)
        // Импортируем функции прямо здесь, чтобы они не конфликтовали с верхним блоком
        const { checkAndResetStreak, getSolvedCountToday } = await import('./db.js');

        // Вызываем проверку стрика
        await checkAndResetStreak(userId);

        const solvedToday = await getSolvedCountToday(userId);
        const user = await findUserById(userId);

        if (!user) return res.status(404).json({ message: "User not found" });

        res.json({
            solvedToday: solvedToday || 0,
            streak: user.daily_streak || 0,
            completedToday: solvedToday >= 10,
            canRestore: (user.daily_streak === 0 && user.previous_streak > 0),
            previousStreak: user.previous_streak || 0
        });
    } catch (err) {
        console.error("Ошибка в puzzle-status:", err);
        res.status(500).json({ error: "Server error" });
    }
});
// 2. Получить следующую задачу
app.get('/api/puzzle/next', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        if (req.session.puzzleOffset === undefined) req.session.puzzleOffset = 0;

        const user = await findUserById(userId);

        // Используем db.get напрямую, так как это специфичный запрос с учетом смещения сессии
        const puzzle = await db.get(
            'SELECT * FROM puzzles ORDER BY id LIMIT 1 OFFSET ?',
            [(user.puzzle_level || 0) + req.session.puzzleOffset]
        );

        if (!puzzle) {
            return res.status(404).json({ message: 'Задачи закончились' });
        }

        req.session.puzzleOffset++;
        res.json(puzzle);
    } catch (error) {
        console.error("Ошибка в /puzzle/next:", error);
        res.status(500).json({ message: 'Ошибка сервера' });
    }
});

// 3. Засчитать решение
app.post('/api/puzzle/solve', authenticateToken, async (req, res) => {
    try {
        const { puzzleId } = req.body;
        const userId = req.user.id;

        // Твоя функция из db.js (она должна обновлять puzzle_level и записывать решение в историю)
        await solvePuzzleUpdate(userId, puzzleId);

        // Уменьшаем офсет сессии, так как уровень в БД вырос, и "следующая" задача теперь имеет другой индекс
        if (req.session.puzzleOffset > 0) {
            req.session.puzzleOffset--;
        }

        res.json({ success: true });
    } catch (e) {
        console.error("Ошибка в /puzzle/solve:", e);
        res.status(500).json({ success: false });
    }
});

// 4. Завершить дневную норму
app.post('/api/puzzle/complete-daily', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        const solvedToday = await getSolvedCountToday(userId);

        if (solvedToday >= 10) {
            // Твоя функция из db.js (обновляет стрик и дату последнего решения)
            const result = await completeDailyPuzzles(userId);
            req.session.puzzleOffset = 0;
            res.json(result);
        } else {
            res.status(400).json({ success: false, message: `Решено только ${solvedToday}/10` });
        }
    } catch (e) {
        console.error("Ошибка в /complete-daily:", e);
        res.status(500).json({ success: false });
    }
});

// 5. Восстановление стрика
app.post('/api/puzzle/restore-streak', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        // Твоя функция из db.js
        const success = await restoreStreak(userId);
        res.json({ success });
    } catch (e) {
        console.error("Ошибка в /restore-streak:", e);
        res.status(500).json({ success: false });
    }
});
// ---------------------------------
// 6. ЛОГИКА SOCKET.IO
// ---------------------------------
io.use((socket, next) => {
    const cookieString = socket.handshake.headers.cookie;
    if (!cookieString) return next(new Error('No cookies'));
    const cookies = cookie.parse(cookieString);
    if (!cookies.token) return next(new Error('No token'));

    jwt.verify(cookies.token, JWT_SECRET, (err, payload) => {
        if (err) return next(new Error('Auth error'));
        socket.user = payload;
        next();
    });
});

io.on('connection', (socket) => {
    // ПРОВЕРКА: Если пользователь не определен, отключаем сразу
    if (!socket.user || !socket.user.id) {
        console.warn('⚠️ Подключение сокета без данных пользователя прервано');
        return socket.disconnect();
    }

    const userId = socket.user.id; // Удобная константа для использования ниже

    onlineUsers.set(userId, { id: userId, username: socket.user.username, socket: socket });

// --- ОБУЧЕНИЕ (С ВКЛАДКАМИ) ---
socket.on('study:join', async ({ roomCode }) => {
    try {
        const room = await findStudyRoomByCode(roomCode);
        if (room) {
            socket.join(roomCode);
            // Если в БД есть вкладки (в виде JSON), парсим их, иначе отправляем стандарт
            const tabsData = room.tabs ? (typeof room.tabs === 'string' ? JSON.parse(room.tabs) : room.tabs) : null;

            socket.emit('study:roomData', {
                ...room,
                tabs: tabsData,
                activeTabId: room.active_tab_id || 'play',
                pgn: room.pgn || '' // Добавили передачу PGN при входе
            });
        }
    } catch (error) {
        console.error('Ошибка в study:join:', error);
    }
});

// --- ОБНОВЛЕННЫЙ БЛОК ХОДОВ (STUDY) ---
// --- ОБНОВЛЕННЫЙ БЛОК ХОДОВ (STUDY) ---

// Предполагается, что эти функции импортированы в начале файла
// import { findStudyRoomByCode, updateRoomTabs, updateUserStats } from './db.js';
// --- ОБНОВЛЕННЫЙ БЛОК ХОДОВ (STUDY) ---
// --- ОБНОВЛЕННЫЙ БЛОК ХОДОВ (STUDY) ---
socket.on('study:move', async ({ roomCode, tabId, fen, pgn, customHistory }) => {
    try {
        const userId = socket.user.id;
        const room = await findStudyRoomByCode(roomCode);
        if (!room) return;

        // Права: учитель, админ или назначенный ученик
        const isTeacher = (Number(room.teacher_id) === Number(userId) || socket.user.role === 'admin' || socket.user.role === 'teacher');
        const isStudent = (Number(room.student_id) === Number(userId));

        // Разрешаем ходить, если это учитель/админ ИЛИ если это ученик этой комнаты
        if (!isTeacher && !isStudent) return;

        // ВАЖНО: Обновляем данные в базе данных.
        // Убедитесь, что ваша функция updateStudyRoomFen умеет принимать и сохранять customHistory в объект вкладки
        await updateStudyRoomFen(roomCode, fen, tabId, pgn, customHistory);

        // Рассылаем обновленное состояние ВСЕМ участникам комнаты, ВКЛЮЧАЯ customHistory
        io.to(roomCode).emit('study:syncMove', {
            tabId,
            fen,
            pgn,
            customHistory: customHistory || [] // Передаем историю, чтобы клиент мог её отрисовать
        });

        // Если это игровая вкладка 'play', проверяем завершение партии
        if (tabId === 'play') {
            const game = new Chess(fen);
            if (game.game_over()) {
                if (room.teacher_id && room.student_id) {
                    let winnerId = null, loserId = null, isDraw = false;

                    if (game.in_checkmate()) {
                        // Если сейчас ход белых и мат — значит победили черные (ученик)
                        if (game.turn() === 'w') {
                            winnerId = room.student_id;
                            loserId = room.teacher_id;
                        } else {
                            winnerId = room.teacher_id;
                            loserId = room.student_id;
                        }
                    } else {
                        // Пат или иная ничья
                        isDraw = true;
                        // Для статистики можно передать обоих или обработать отдельно в updateUserStats
                    }

                    await updateUserStats(winnerId, loserId, isDraw);
                    io.to(roomCode).emit('study:gameFinished', { winnerId, isDraw });
                }
            }
        }
    } catch (error) {
        console.error('Ошибка в study:move:', error);
    }
});



socket.on('study:updateTabs', async ({ roomCode, tabs, activeTabId }) => {
    try {
        const userId = socket.user.id;
        const room = await findStudyRoomByCode(roomCode);

        if (room && (Number(room.teacher_id) === Number(userId) || socket.user.role === 'admin' || socket.user.role === 'teacher')) {
            const { updateRoomTabs } = await import('./db.js');
            await updateRoomTabs(roomCode, tabs, activeTabId);
            io.to(roomCode).emit('study:syncTabs', { tabs, activeTabId });
        }
    } catch (error) {
        console.error('Ошибка в study:updateTabs:', error);
    }
});

// --- ПЕРЕКЛЮЧЕНИЕ ВКЛАДКИ ---
socket.on('study:switchTab', async ({ roomCode, tabId }) => {
    try {
        const userId = socket.user.id;
        const room = await findStudyRoomByCode(roomCode);

        if (room && (Number(room.teacher_id) === Number(userId) || socket.user.role === 'admin' || socket.user.role === 'teacher')) {
            const { updateActiveTab } = await import('./db.js');
            await updateActiveTab(roomCode, tabId);
            socket.to(roomCode).emit('study:syncSwitchTab', { tabId });
        }
    } catch (error) {
        console.error('Ошибка в study:switchTab:', error);
    }
});

// --- РИСОВАНИЕ ---
socket.on('study:draw', async ({ roomCode, tabId, shapes }) => {
    try {
        const userId = socket.user.id;
        const room = await findStudyRoomByCode(roomCode);

        // Рисовать может только учитель/админ
        if (room && (Number(room.teacher_id) === Number(userId) || socket.user.role === 'admin' || socket.user.role === 'teacher')) {
            socket.to(roomCode).emit('study:syncDraw', { tabId, shapes });
        }
    } catch (error) {
        console.error('Ошибка в study:draw:', error);
    }
});


    socket.on('findGame', () => {
        const currentUserId = userId;
        if (!currentUserId) return;

        const idx = matchmakingQueue.findIndex(s => s.user?.id === currentUserId);
        if (idx !== -1) matchmakingQueue.splice(idx, 1);
        matchmakingQueue.push(socket);
        if (matchmakingQueue.length >= 2) {
            createAndStartGame(matchmakingQueue.shift(), matchmakingQueue.shift());
        }
    });

    socket.on('tournament:getState', (tournamentId) => {
        if (mainTournament && mainTournament.id === tournamentId) {
            socket.emit('tournament:stateUpdate', mainTournament.getState());
        }
    });

    socket.on('tournament:register', () => {
        if (!mainTournament || !socket.user) return;
        const result = mainTournament.register(socket.user, socket);
        if (result.success) io.emit('tournament:stateUpdate', mainTournament.getState());
    });

    socket.on('tournament:leave', () => {
        if (mainTournament && socket.user) {
            mainTournament.removePlayer(socket);
            io.emit('tournament:stateUpdate', mainTournament.getState());
        }
    });

    socket.on('tournament:start', () => {
        if (mainTournament) mainTournament.start();
    });

    socket.on('tournament:game:join', ({ gameId }) => {
        const game = activeGames.get(gameId);
        if (!game || !socket.user) return;
        socket.join(gameId);
        socket.emit('game:state', {
            fen: game.chess.fen(),
            color: game.getPlayerColor(userId),
            playerWhite: game.playerWhite.user?.username || '?',
            playerBlack: game.playerBlack.user?.username || '?'
        });
    });

    socket.on('tournament:game:move', ({ gameId, move }) => {
        const game = activeGames.get(gameId);
        if (game && socket.user) game.makeMove(move, userId);
    });

    socket.on('tournament:game:resign', ({ gameId }) => {
        const game = activeGames.get(gameId);
        if (game && socket.user) game.resign(userId);
    });

    socket.on('disconnect', () => {
        if (userId) {
            onlineUsers.delete(userId);
        }
    });

    // --- ОБРАБОТКА ИГРОВЫХ СОБЫТИЙ В SERVER.JS ---

    socket.on('move', ({ move, roomId }) => {
        const gameInstance = activeGames.get(roomId);
        if (gameInstance) {
            gameInstance.makeMove(socket.id, move);
        }
    });

    socket.on('surrender', ({ roomId }) => {
        const gameInstance = activeGames.get(roomId);
        if (gameInstance) {
            gameInstance.handleSurrender(socket.id);
        }
    });

    socket.on('rematch', ({ roomId }) => {
        const gameInstance = activeGames.get(roomId);
        if (gameInstance) {
            gameInstance.handleRematchRequest(socket.id);
        }
    });

    socket.on('rematchAccepted', ({ roomId }) => {
        const gameInstance = activeGames.get(roomId);
        if (gameInstance) {
            gameInstance.handleRematchAccept(socket.id);
        }
    });
});
// ---------------------------------
// 7. ЗАПУСК
// ---------------------------------
// 1. Убедись, что в начале файла у тебя созданы эти переменные:
// const httpServer = http.createServer(app);
// const io = new Server(httpServer, { cors: corsOptions });

const startServer = async () => {
    try {
        // Подготовка базы
        await initDb();
        await initPuzzlesTable();

        console.log('[DB] Все таблицы проверены и готовы.');

        // ВАЖНО: Слушаем именно httpServer, к которому привязаны сокеты!
        httpServer.listen(3000, '127.0.0.1', () => {
            console.log(`🚀 Шахматный сервер (API + Sockets) запущен на порту 3000`);
            console.log(`🌍 Доступен через Nginx: https://chessrad.app`);
        });

    } catch (err) {
        console.error("КРИТИЧЕСКАЯ ОШИБКА ЗАПУСКА:", err);
    }
}
startServer();
