import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';

export let db;

const LEVEL_THRESHOLDS = [
    { name: 'Большой мастер', min: 7500 },
    { name: 'Мастер', min: 4500 },
    { name: 'Опытный', min: 2500 },
    { name: 'Любитель', min: 1500 },
    { name: 'Новичок', min: 0 }
];

function getLevelByRating(rating) {
    const level = LEVEL_THRESHOLDS.find(l => rating >= l.min);
    return level ? level.name : 'Новичок';
}

export async function getDbConnection() {
    if (!db) {
        const dbDir = './db';
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        db = await open({
            filename: path.join(dbDir, 'chess-app.db'),
            driver: sqlite3.Database
        });

        try {
            await db.run('PRAGMA journal_mode = WAL');
            await db.run('PRAGMA busy_timeout = 5000');
            console.log('[DB] Настройки оптимизации применены: WAL mode и Busy Timeout.');
        } catch (err) {
            console.error('[DB] Ошибка при настройке PRAGMA:', err);
        }
    }
    return db;
}

export const initDb = async () => {
    const db = await getDbConnection();

    // Таблица пользователей
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'student',
            wins INTEGER NOT NULL DEFAULT 0,
            losses INTEGER NOT NULL DEFAULT 0,
            draws INTEGER NOT NULL DEFAULT 0,
            level TEXT NOT NULL DEFAULT 'Новичок',
            rating INTEGER NOT NULL DEFAULT 500,
            win_streak INTEGER NOT NULL DEFAULT 0,
            daily_streak INTEGER NOT NULL DEFAULT 0,
            previous_streak INTEGER NOT NULL DEFAULT 0,
            last_puzzle_date TEXT DEFAULT NULL,
            puzzle_level INTEGER NOT NULL DEFAULT 1,
            trophies TEXT DEFAULT '[]',
            avatar_url TEXT DEFAULT "",
            must_change_password INTEGER DEFAULT 0
        );
    `);

    // История игр
    await db.exec(`
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player1_id INTEGER,
            player2_id INTEGER,
            winner_id INTEGER,
            result TEXT,
            game_type TEXT DEFAULT 'Обычный',
            date TEXT,
            FOREIGN KEY(player1_id) REFERENCES users(id),
            FOREIGN KEY(player2_id) REFERENCES users(id)
        );
    `);

    // Учебные комнаты
    await db.exec(`
        CREATE TABLE IF NOT EXISTS study_rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_code TEXT UNIQUE NOT NULL,
            teacher_id INTEGER NOT NULL,
            student_id INTEGER,
            fen TEXT DEFAULT 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            pgn TEXT DEFAULT '',
            tabs TEXT DEFAULT '[{"id":"play","type":"play","fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1","shapes":[]}]',
            active_tab_id TEXT DEFAULT 'play',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(teacher_id) REFERENCES users(id),
            FOREIGN KEY(student_id) REFERENCES users(id)
        );
    `);

    // Библиотека позиций

// Библиотека позиций (Обновленная версия)
await db.exec(`
    CREATE TABLE IF NOT EXISTS position_library (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        big_folder TEXT DEFAULT 'Без категории', -- Надпапка
        category TEXT DEFAULT 'Общее',           -- Папка
        fen TEXT NOT NULL,
        order_index INTEGER DEFAULT 0,           -- Позиция в списке для тасования
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(teacher_id) REFERENCES users(id)
    );
`);

    // ТАБЛИЦА РЕШЕННЫХ ПАЗЛОВ
    await db.exec(`
        CREATE TABLE IF NOT EXISTS user_puzzles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            puzzle_id TEXT,
            solved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
    `);

// --- ТАБЛИЦЫ ДЛЯ НЕМЕЦКОГО ЯЗЫКА ---
    await db.exec(`
        CREATE TABLE IF NOT EXISTS german_submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            teacher_id INTEGER NOT NULL,
            original_text TEXT,          -- Текст ученика
            corrected_text TEXT,         -- Твои правки
            teacher_comment TEXT,        -- Твой комментарий
            topic TEXT,                  -- Тема (например, "Konjunktiv II")
            status TEXT DEFAULT 'new',   -- 'new', 'reviewed'
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(student_id) REFERENCES users(id),
            FOREIGN KEY(teacher_id) REFERENCES users(id)
        );
    `);

    // Таблица для хранения общих заметок или плана урока
    await db.exec(`
        CREATE TABLE IF NOT EXISTS german_lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lesson_id TEXT UNIQUE,       -- ID комнаты (для Socket.io)
            content TEXT DEFAULT '',     -- Общий текст на доске
            last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Миграции
    const userTableInfo = await db.all("PRAGMA table_info(users)");
    const userColumns = userTableInfo.map(c => c.name);
    if (!userColumns.includes('daily_streak')) await db.exec('ALTER TABLE users ADD COLUMN daily_streak INTEGER DEFAULT 0');
    if (!userColumns.includes('previous_streak')) await db.exec('ALTER TABLE users ADD COLUMN previous_streak INTEGER DEFAULT 0');
    if (!userColumns.includes('last_puzzle_date')) await db.exec('ALTER TABLE users ADD COLUMN last_puzzle_date TEXT DEFAULT NULL');
    if (!userColumns.includes('puzzle_level')) await db.exec('ALTER TABLE users ADD COLUMN puzzle_level INTEGER DEFAULT 1');

    const roomTableInfo = await db.all("PRAGMA table_info(study_rooms)");
    const roomColumns = roomTableInfo.map(c => c.name);
    if (!roomColumns.includes('tabs')) {
        await db.exec('ALTER TABLE study_rooms ADD COLUMN tabs TEXT DEFAULT \'[{"id":"play","type":"play","fen":"rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1","shapes":[]}]\'');
    }
    if (!roomColumns.includes('active_tab_id')) {
        await db.exec('ALTER TABLE study_rooms ADD COLUMN active_tab_id TEXT DEFAULT "play"');
    }
    if (!roomColumns.includes('pgn')) {
        await db.exec('ALTER TABLE study_rooms ADD COLUMN pgn TEXT DEFAULT ""');
    }
    console.log('[DB] База данных инициализирована.');
};

// --- УПРАВЛЕНИЕ ПОЛЬЗОВАТЕЛЯМИ ---

export const addUser = async (username, password, role = 'student') => {
    const db = await getDbConnection();
    const password_hash = await bcrypt.hash(password, 10);
    const result = await db.run(
        'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
        [username, password_hash, role]
    );
    return result.lastID;
};

export const findUserByUsername = async (username) => {
    const db = await getDbConnection();
    return db.get('SELECT * FROM users WHERE username = ?', username);
};

export const findUserById = async (id) => {
    const db = await getDbConnection();
    const user = await db.get(`
        SELECT id, username, role, wins, losses, draws, level, rating,
               win_streak, daily_streak, previous_streak, last_puzzle_date, puzzle_level,
               trophies, must_change_password, avatar_url
        FROM users WHERE id = ?
    `, id);

    if (!user) return null;

    const history = await db.all(`
        SELECT
            CASE WHEN g.player1_id = ? THEN u2.username ELSE u1.username END as opponent,
            g.result,
            g.game_type as type
        FROM games g
        LEFT JOIN users u1 ON g.player1_id = u1.id
        LEFT JOIN users u2 ON g.player2_id = u2.id
        WHERE g.player1_id = ? OR g.player2_id = ?
        ORDER BY g.id DESC LIMIT 5
    `, [id, id, id]);

    return { ...user, history: history || [] };
};

// --- ПАЗЛЫ И СТРИКИ ---

export async function initPuzzlesTable() {
    const database = await getDbConnection();
    await database.exec(`
        CREATE TABLE IF NOT EXISTS puzzles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fen TEXT NOT NULL,
            solution TEXT NOT NULL,
            theme TEXT NOT NULL,
            description TEXT
        )
    `);
}

/**
 * Проверяет, не протух ли стрик (более 48 часов с последней задачи).
 * Если протух — сохраняет его в previous_streak и обнуляет основной.
 */
export const checkAndResetStreak = async (userId) => {
    const database = await getDbConnection();
    const user = await database.get('SELECT last_puzzle_date, daily_streak FROM users WHERE id = ?', [userId]);

    if (!user || !user.last_puzzle_date || user.daily_streak === 0) return;

    const today = new Date();
    const lastDate = new Date(user.last_puzzle_date);
    const diffTime = Math.abs(today - lastDate);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays > 1) {
        // Стрик потерян. Сохраняем его для возможности восстановления и обнуляем.
        await database.run(
            'UPDATE users SET previous_streak = daily_streak, daily_streak = 0 WHERE id = ?',
            [userId]
        );
        console.log(`[Streak] Стрик пользователя ${userId} сброшен (пропущено дней: ${diffDays})`);
    }
};

/**
 * Восстанавливает стрик из резервной копии.
 */
export const restoreStreak = async (userId) => {
    const database = await getDbConnection();
    await database.run(`
        UPDATE users
        SET daily_streak = previous_streak, previous_streak = 0
        WHERE id = ? AND daily_streak = 0 AND previous_streak > 0
    `, [userId]);
    return true;
};

export async function getNextPuzzleForUser(userId) {
    const database = await getDbConnection();
    const user = await database.get('SELECT puzzle_level FROM users WHERE id = ?', [userId]);
    if (!user) return await database.get('SELECT * FROM puzzles ORDER BY RANDOM() LIMIT 1');

    let puzzle = await database.get('SELECT * FROM puzzles WHERE id >= ? ORDER BY id ASC LIMIT 1', [user.puzzle_level]);
    if (!puzzle) puzzle = await database.get('SELECT * FROM puzzles ORDER BY RANDOM() LIMIT 1');
    return puzzle;
}

export const solvePuzzleUpdate = async (userId, puzzleId, points = 5) => {
    const database = await getDbConnection();
    await database.run('INSERT INTO user_puzzles (user_id, puzzle_id) VALUES (?, ?)', [userId, puzzleId]);
    await database.run(`
        UPDATE users
        SET rating = rating + ?, puzzle_level = puzzle_level + 1
        WHERE id = ?`, [points, userId]
    );
    const user = await database.get('SELECT rating FROM users WHERE id = ?', [userId]);
    if (user) {
        const newLevel = getLevelByRating(user.rating);
        await database.run('UPDATE users SET level = ? WHERE id = ?', [newLevel, userId]);
        return { success: true, newRating: user.rating, level: newLevel };
    }
    return { success: true };
};

export const completeDailyPuzzles = async (userId) => {
    const database = await getDbConnection();
    const today = new Date().toISOString().split('T')[0];

    // Перед начислением проверяем, не нужно ли сбросить старый стрик
    await checkAndResetStreak(userId);

    const user = await database.get('SELECT last_puzzle_date, daily_streak, rating FROM users WHERE id = ?', [userId]);

    let newStreak = 1;
    if (user && user.last_puzzle_date === today) {
        newStreak = user.daily_streak; // Уже решено сегодня
    } else if (user && user.last_puzzle_date) {
        const lastDate = new Date(user.last_puzzle_date);
        const currentDate = new Date(today);
        const diffDays = Math.ceil(Math.abs(currentDate - lastDate) / (1000 * 60 * 60 * 24));

        if (diffDays === 1) {
            newStreak = user.daily_streak + 1;
        } else {
            newStreak = 1;
        }
    }

    await database.run(`
        UPDATE users SET rating = rating + 50, daily_streak = ?, last_puzzle_date = ?, previous_streak = 0 WHERE id = ?`,
        [newStreak, today, userId]
    );

    const updatedUser = await database.get('SELECT rating FROM users WHERE id = ?', [userId]);
    if (updatedUser) {
        const newLevel = getLevelByRating(updatedUser.rating);
        await database.run('UPDATE users SET level = ? WHERE id = ?', [newLevel, userId]);
        return { success: true, newStreak, newRating: updatedUser.rating };
    }
    return { success: true, newStreak };
};

// --- ОБУЧАЮЩИЕ КЛАССЫ ---

export const createStudyRoom = async (teacherId, roomCode) => {
    const db = await getDbConnection();
    await db.run('INSERT INTO study_rooms (teacher_id, room_code) VALUES (?, ?)', [teacherId, roomCode]);
    return { teacherId, roomCode };
};

export const findStudyRoomByCode = async (code) => {
    const db = await getDbConnection();
    return await db.get(`
        SELECT r.*, u.username as teacher_name FROM study_rooms r
        JOIN users u ON r.teacher_id = u.id WHERE r.room_code = ?`, [code]);
};

export const countTeacherRooms = async (teacherId) => {
    const db = await getDbConnection();
    const result = await db.get('SELECT COUNT(*) as count FROM study_rooms WHERE teacher_id = ?', [teacherId]);
    return result ? result.count : 0;
};

export const getTeacherRooms = async (teacherId) => {
    const db = await getDbConnection();
    return await db.all('SELECT * FROM study_rooms WHERE teacher_id = ? ORDER BY created_at DESC', [teacherId]);
};

export const joinStudentToRoom = async (roomCode, studentId) => {
    const db = await getDbConnection();
    await db.run('UPDATE study_rooms SET student_id = ? WHERE room_code = ?', [studentId, roomCode]);
};

export const deleteStudyRoom = async (roomCode, teacherId) => {
    const db = await getDbConnection();
    return await db.run('DELETE FROM study_rooms WHERE room_code = ? AND teacher_id = ?', [roomCode, teacherId]);
};

// --- ВКЛАДКИ ---

export const updateRoomTabs = async (roomCode, tabs, activeTabId) => {
    const db = await getDbConnection();
    const tabsJson = JSON.stringify(tabs);
    return await db.run('UPDATE study_rooms SET tabs = ?, active_tab_id = ? WHERE room_code = ?',
        [tabsJson, activeTabId, roomCode]);
};

export const updateActiveTab = async (roomCode, activeTabId) => {
    const db = await getDbConnection();
    return await db.run('UPDATE study_rooms SET active_tab_id = ? WHERE room_code = ?', [activeTabId, roomCode]);
};


export const updateStudyRoomFen = async (roomCode, fen, tabId = 'play', pgn = '', customHistory = []) => {
    const db = await getDbConnection();
    const room = await db.get('SELECT tabs FROM study_rooms WHERE room_code = ?', [roomCode]);

    if (!room || !room.tabs) {
        return await db.run(
            'UPDATE study_rooms SET fen = ?, pgn = ? WHERE room_code = ?',
            [fen, pgn, roomCode]
        );
    }

    let tabs = JSON.parse(room.tabs);
    tabs = tabs.map(t => {
        if (t.id === tabId) {
            return {
                ...t,
                fen: fen,
                pgn: pgn,
                customHistory: customHistory || []
            };
        }
        return t;
    });

    const tabsJson = JSON.stringify(tabs);
    return await db.run(
        'UPDATE study_rooms SET fen = ?, pgn = ?, tabs = ? WHERE room_code = ?',
        [fen, pgn, tabsJson, roomCode]
    );
};

// --- ТРОФЕИ ---

export const addTrophyToUser = async (userId, trophy) => {
    const db = await getDbConnection();
    try {
        const user = await db.get('SELECT trophies FROM users WHERE id = ?', [userId]);
        let trophies = [];
        try { trophies = (user && user.trophies) ? JSON.parse(user.trophies) : []; } catch (e) { trophies = []; }
        trophies.unshift({ ...trophy, date: new Date().toLocaleDateString('ru-RU') });
        await db.run('UPDATE users SET trophies = ? WHERE id = ?', [JSON.stringify(trophies), userId]);
        return true;
    } catch (e) { return false; }
};

// --- БИБЛИОТЕКА ПОЗИЦИЙ ---


// --- БИБЛИОТЕКА ПОЗИЦИЙ ---

export const addPosition = async (teacherId, title, category, fen, big_folder) => {
    const db = await getDbConnection();
    // Добавлена колонка big_folder в INSERT
    return await db.run(
        'INSERT INTO position_library (teacher_id, title, category, fen, big_folder) VALUES (?, ?, ?, ?, ?)',
        [teacherId, title, category || 'Общее', fen, big_folder || 'Без раздела']
    );
};

export const getTeacherPositions = async () => {
    const db = await getDbConnection();
    // Добавлен ORDER BY по big_folder для правильной группировки
    return await db.all(`
        SELECT pl.*, u.username as author_name FROM position_library pl
        JOIN users u ON pl.teacher_id = u.id ORDER BY big_folder, category, title`);
};

export const deletePosition = async (posId) => {
    const db = await getDbConnection();
    return await db.run('DELETE FROM position_library WHERE id = ?', [posId]);
};

export const updatePosition = async (posId, teacherId, data) => {
    const db = await getDbConnection();
    // Добавлено обновление big_folder
    return await db.run(
        'UPDATE position_library SET title = ?, category = ?, fen = ?, big_folder = ? WHERE id = ?',
        [data.title, data.category, data.fen, data.big_folder, posId]
    );
};

// --- СТАТИСТИКА ИГР ---

// --- ИСПРАВЛЕННАЯ СТАТИСТИКА ИГР ---

export const saveGameResult = async (p1_id, p2_id, winner_id, type = 'Обычный') => {
    const db = await getDbConnection();
    const date = new Date().toLocaleDateString('ru-RU');

    // Безопасная проверка результата для текста
    let resText = 'Ничья';
    if (winner_id !== null) {
        resText = (String(winner_id) === String(p1_id)) ? 'Победа' : 'Поражение';
    }

    try {
        await db.run(
            'INSERT INTO games (player1_id, player2_id, winner_id, result, game_type, date) VALUES (?, ?, ?, ?, ?, ?)',
            [p1_id, p2_id, winner_id, resText, type, date]
        );
    } catch (e) {
        console.error('[DB] Ошибка сохранения игры:', e);
    }
};

export const updateUserStats = async (winnerId, loserId, isDraw = false) => {
    const db = await getDbConnection();
    // Приводим к числам, чтобы избежать ошибок сравнения строк и чисел
    const wId = winnerId ? Number(winnerId) : null;
    const lId = loserId ? Number(loserId) : null;

    try {
        if (isDraw && wId && lId) {
            // Ничья: +5 обоим, сброс стрика
            await db.run('UPDATE users SET draws = draws + 1, rating = rating + 5, win_streak = 0 WHERE id = ? OR id = ?', [wId, lId]);
            await saveGameResult(wId, lId, null);
        } else if (wId && lId) {
            // Победа/Поражение
            const winner = await db.get('SELECT win_streak, rating FROM users WHERE id = ?', [wId]);
            const newStreak = (winner ? winner.win_streak : 0) + 1;

            // Бонус за серию побед
            const points = newStreak >= 3 ? 25 : 15;

            await db.run('UPDATE users SET wins = wins + 1, rating = rating + ?, win_streak = ? WHERE id = ?', [points, newStreak, wId]);
            await db.run('UPDATE users SET losses = losses + 1, rating = MAX(0, rating - 10), win_streak = 0 WHERE id = ?', [lId]);

            await saveGameResult(wId, lId, wId);
        }

        // ВАЖНО: Обновляем текстовые уровни (звания) после изменения рейтинга
        const affectedUsers = isDraw ? [wId, lId] : [wId, lId];
        for (const uId of affectedUsers) {
            if (uId) {
                const user = await db.get('SELECT rating FROM users WHERE id = ?', [uId]);
                if (user) {
                    const newLevelName = getLevelByRating(user.rating);
                    await db.run('UPDATE users SET level = ? WHERE id = ?', [newLevelName, uId]);
                }
            }
        }

        return true;
    } catch (error) {
        console.error('[DB] Ошибка в updateUserStats:', error);
        return false;
    }
};
export async function getAllUsers(sortBy = 'new') {
    const db = await getDbConnection();
    let orderBy = (sortBy === 'old') ? 'id ASC' : (sortBy === 'rating') ? 'rating DESC' : (sortBy === 'alphabet') ? 'username COLLATE NOCASE ASC' : 'id DESC';
    return db.all(`SELECT id, username, role, rating, win_streak, daily_streak FROM users ORDER BY ${orderBy}`);
}

export async function updateUserRole(userId, newRole) {
    const db = await getDbConnection();
    return db.run('UPDATE users SET role = ? WHERE id = ?', [newRole, userId]);
}

export async function deleteUser(userId) {
    const db = await getDbConnection();
    return await db.run('DELETE FROM users WHERE id = ?', [userId]);
}

export async function resetUserPassword(userId, hashedPassword) {
    const db = await getDbConnection();
    // Мы принимаем уже готовый hashedPassword из контроллера
    const result = await db.run(
        'UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?',
        [hashedPassword, userId]
    );
    return result.changes > 0;
}

export async function updateOwnPassword(userId, hashedPassword) {
    const db = await getDbConnection();
    // Убираем внутренний bcrypt.hash, так как хешируем в server.js
    return db.run(
        'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?',
        [hashedPassword, userId]
    );
}

export const getSolvedCountToday = async (userId) => {
    const db = await getDbConnection();
    const result = await db.get(`
        SELECT COUNT(DISTINCT puzzle_id) as count
        FROM user_puzzles
        WHERE user_id = ? AND date(solved_at) = date('now')
    `, [userId]);
    return result ? result.count : 0;
};

export const checkDailyGoalReached = async (userId) => {
    const count = await getSolvedCountToday(userId);
    return count >= 10;
};

// Сохранение текста ученика
export const saveGermanSubmission = async (studentId, teacherId, text, topic) => {
    const db = await getDbConnection();
    return await db.run(
        'INSERT INTO german_submissions (student_id, teacher_id, original_text, topic) VALUES (?, ?, ?, ?)',
        [studentId, teacherId, text, topic]
    );
};

// Получение всех работ для учителя (для тебя)
export const getSubmissionsForTeacher = async (teacherId) => {
    const db = await getDbConnection();
    return await db.all(`
        SELECT s.*, u.username as student_name
        FROM german_submissions s
        JOIN users u ON s.student_id = u.id
        WHERE s.teacher_id = ? ORDER BY s.created_at DESC
    `, [teacherId]);
};

// Обновление урока (тот самый текст, который синхронизируется)
export const updateLessonContent = async (lessonId, content) => {
    const db = await getDbConnection();
    return await db.run(
        'INSERT INTO german_lessons (lesson_id, content) VALUES (?, ?) ON CONFLICT(lesson_id) DO UPDATE SET content = ?, last_updated = CURRENT_TIMESTAMP',
        [lessonId, content, content]
    );
};
