import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Конфигурация
const CONFIG = {
    apiToken: 'Bearer acfb46b5-b0c3-4359-bc04-f91f97ad74b0',
    playerNickname: 'DeRoyse',
    port: 3000
};

// Кэш данных
let cachedData = null;
let lastUpdate = 0;
const CACHE_DURATION = 15000; // 15 секунд

// Получение данных игрока из Faceit API
async function fetchPlayerData() {
    const nickname = CONFIG.playerNickname;

    // Поиск игрока по нику
    const playerUrl = `https://open.faceit.com/data/v4/players?nickname=${encodeURIComponent(nickname)}`;

    const playerResponse = await fetch(playerUrl, {
        headers: {
            'Authorization': CONFIG.apiToken,
            'Accept': 'application/json'
        }
    });

    if (!playerResponse.ok) {
        throw new Error(`Ошибка получения игрока: ${playerResponse.status}`);
    }

    const player = await playerResponse.json();
    const playerId = player.player_id;
    const cs2Stats = player.games?.cs2 || {};

    // Получение общей статистики (lifetime)
    const statsUrl = `https://open.faceit.com/data/v4/players/${playerId}/stats/cs2`;
    const statsResponse = await fetch(statsUrl, {
        headers: {
            'Authorization': CONFIG.apiToken,
            'Accept': 'application/json'
        }
    });

    let lifetimeStats = {};
    if (statsResponse.ok) {
        const statsData = await statsResponse.json();
        lifetimeStats = statsData.lifetime || {};
    }

    // Получение истории матчей (последние 20)
    const matchesUrl = `https://open.faceit.com/data/v4/players/${playerId}/history?game=cs2&limit=20`;

    const historyResponse = await fetch(matchesUrl, {
        headers: {
            'Authorization': CONFIG.apiToken,
            'Accept': 'application/json'
        }
    });

    let historyItems = [];
    if (historyResponse.ok) {
        const historyData = await historyResponse.json();
        historyItems = historyData.items || [];
    }

    // Получаем детальную статистику для каждого матча параллельно
    const matchStatsPromises = historyItems.map(async (item) => {
        try {
            const matchDetailsUrl = `https://open.faceit.com/data/v4/matches/${item.match_id}/stats`;
            const statsRes = await fetch(matchDetailsUrl, {
                headers: {
                    'Authorization': CONFIG.apiToken,
                    'Accept': 'application/json'
                }
            });
            if (statsRes.ok) {
                return await statsRes.json();
            }
        } catch (e) {
            console.error(`Ошибка загрузки статистики матча ${item.match_id}:`, e.message);
        }
        return null;
    });

    const allMatchStats = (await Promise.all(matchStatsPromises)).filter(s => s !== null);

    // Расчёт статистики за последние 20 матчей
    const last20Stats = calculateLast20Stats(allMatchStats, playerId, lifetimeStats);

    return {
        elo: cs2Stats.faceit_elo || 0,
        level: cs2Stats.skill_level || 1,
        kdr: parseFloat(lifetimeStats["Average K/D Ratio"]) || 0,
        lastMatchId: historyItems[0]?.match_id || null,
        recentResults: historyItems.slice(0, 5).map(match => {
            const teamId = match.teams.faction1.players.some(p => p.player_id === playerId) ? 'faction1' : 'faction2';
            return match.results?.winner === teamId ? 'W' : 'L';
        }),
        winrate: last20Stats.winrate,
        avgKills: last20Stats.avgKills,
        hsPercent: last20Stats.hsPercent,
        kdRatio: last20Stats.kdRatio,
        krRatio: last20Stats.krRatio,
        nickname: player.nickname || nickname,
        avatar: player.avatar || '',
        lastUpdated: new Date().toISOString()
    };
}

// Расчёт статистики за последние 20 матчей
function calculateLast20Stats(allMatchStats, playerId, generalStats) {
    if (!allMatchStats || allMatchStats.length === 0) {
        return {
            winrate: parseInt(generalStats["Win Rate %"]) || 0,
            avgKills: 0, // Недоступно в общей статистике напрямую как среднее за матч
            hsPercent: parseInt(generalStats["Average Headshots %"]) || 0,
            kdRatio: parseFloat(generalStats["Average K/D Ratio"]) || 0,
            krRatio: 0
        };
    }

    let wins = 0;
    let totalKills = 0;
    let totalDeaths = 0;
    let totalRounds = 0;
    let totalHSPercent = 0;
    let totalKDRatio = 0;
    let totalKRRatio = 0;
    let statsCount = 0;

    allMatchStats.forEach(matchData => {
        // Ищем нашего игрока в раундах и командах
        matchData.rounds?.forEach(round => {
            round.teams?.forEach(team => {
                const player = team.players?.find(p => p.player_id === playerId);
                if (player && player.player_stats) {
                    const ps = player.player_stats;

                    if (ps.Result === "1") wins++;

                    totalKills += parseInt(ps.Kills) || 0;
                    totalDeaths += parseInt(ps.Deaths) || 0;
                    totalHSPercent += parseInt(ps["Headshots %"]) || 0;
                    totalKDRatio += parseFloat(ps["K/D Ratio"]) || 0;
                    totalKRRatio += parseFloat(ps["K/R Ratio"]) || 0;

                    statsCount++;
                }
            });
        });
    });

    if (statsCount === 0) {
        return {
            winrate: 0,
            avgKills: 0,
            hsPercent: 0,
            kdRatio: 0,
            krRatio: 0
        };
    }

    return {
        winrate: Math.round((wins / statsCount) * 100),
        avgKills: totalKills / statsCount,
        hsPercent: Math.round(totalHSPercent / statsCount),
        kdRatio: totalKDRatio / statsCount,
        krRatio: totalKRRatio / statsCount
    };
}

// HTTP сервер
const server = http.createServer(async (req, res) => {
    // CORS заголовки
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.method === 'GET' && req.url === '/api/stats') {
        try {
            const now = Date.now();

            // Используем кэш если данные свежие и без ошибок
            if (cachedData && !cachedData.error && (now - lastUpdate) < CACHE_DURATION) {
                res.writeHead(200);
                res.end(JSON.stringify({ ...cachedData, fromCache: true }));
                return;
            }

            // Получаем свежие данные
            const data = await fetchPlayerData();

            // Кэшируем только успешные данные
            if (!data.error) {
                cachedData = data;
                lastUpdate = now;
            }

            res.writeHead(200);
            res.end(JSON.stringify(data));

        } catch (error) {
            console.error('Ошибка:', error.message);

            // Сбрасываем кэш при ошибке
            cachedData = null;

            res.writeHead(500);
            res.end(JSON.stringify({ error: error.message }));
        }
        return;
    }

    // Раздача статических файлов
    if (req.method === 'GET') {
        let filePath = req.url === '/' ? '/overlay.html' : req.url;
        filePath = path.join(__dirname, filePath);

        const ext = path.extname(filePath);
        const contentTypes = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.png': 'image/png',
            '.jpg': 'image/jpeg'
        };

        fs.readFile(filePath, (err, content) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    res.writeHead(404);
                    res.end('Файл не найден');
                } else {
                    res.writeHead(500);
                    res.end('Ошибка сервера');
                }
            } else {
                res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
                res.end(content);
            }
        });
        return;
    }

    res.writeHead(404);
    res.end('Не найдено');
});

server.listen(CONFIG.port, () => {
    console.log(`\n🎮 Faceit Overlay Server запущен!`);
    console.log(`📊 Оверлей: http://localhost:${CONFIG.port}`);
    console.log(` API: http://localhost:${CONFIG.port}/api/stats`);
    console.log(`👤 Игрок: ${CONFIG.playerNickname}`);
    console.log(`\nДля остановки нажмите Ctrl+C\n`);
});
