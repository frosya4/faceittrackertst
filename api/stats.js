// Конфигурация
const CONFIG = {
    apiToken: 'acfb46b5-b0c3-4359-bc04-f91f97ad74b0', // Взето из server.js
    playerNickname: 'DeRoyse'
};

const CACHE_DURATION = 15000; // 15 секунд
let cache = {
    data: null,
    timestamp: 0
};

export default async function handler(req, res) {
    // Включаем CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const now = Date.now();
    if (cache.data && (now - cache.timestamp < CACHE_DURATION)) {
        return res.status(200).json({ ...cache.data, fromCache: true });
    }

    try {
        const stats = await fetchPlayerData();
        cache.data = stats;
        cache.timestamp = now;
        res.status(200).json({ ...stats, fromCache: false });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: error.message });
    }
}

async function fetchPlayerData() {
    const playerUrl = `https://open.faceit.com/data/v4/players?nickname=${CONFIG.playerNickname}`;
    const headers = { 'Authorization': `Bearer ${CONFIG.apiToken}` };

    console.log('Fetching player info...');
    const playerRes = await fetch(playerUrl, { headers });

    if (!playerRes.ok) {
        const errorText = await playerRes.text();
        throw new Error(`Player ${CONFIG.playerNickname} not found: ${playerRes.status} ${errorText}`);
    }

    const playerData = await playerRes.json();
    const playerId = playerData.player_id;

    const statsUrl = `https://open.faceit.com/data/v4/players/${playerId}/stats/cs2`;
    const historyUrl = `https://open.faceit.com/data/v4/players/${playerId}/history?game=cs2&limit=20`;

    console.log('Fetching history and lifetime stats...');
    const [statsRes, historyRes] = await Promise.all([
        fetch(statsUrl, { headers }),
        fetch(historyUrl, { headers })
    ]);

    if (!statsRes.ok || !historyRes.ok) {
        throw new Error(`Faceit API error: Stats ${statsRes.status}, History ${historyRes.status}`);
    }

    const statsData = await statsRes.json();
    const historyData = await historyRes.json();

    const lifetimeStats = statsData.lifetime || {};
    const matches = historyData.items || [];

    console.log(`Fetching details for ${matches.length} matches...`);
    const matchStatsPromises = matches.map(match =>
        fetch(`https://open.faceit.com/data/v4/matches/${match.match_id}/stats`, { headers })
            .then(async res => {
                if (!res.ok) throw new Error(`Match ${match.match_id} error: ${res.status}`);
                return res.json();
            })
            .catch(err => {
                console.warn(err.message);
                return null;
            })
    );

    const allMatchStats = await Promise.all(matchStatsPromises);
    const last20Stats = calculateLast20Stats(allMatchStats, playerId, lifetimeStats);

    // Получаем результаты последних 5 матчей
    const recentResults = matches.slice(0, 5).map(match => {
        const teamId = match.teams.faction1.players.some(p => p.player_id === playerId) ? 'faction1' : 'faction2';
        const winnerId = match.results?.winner;
        return winnerId === teamId ? 'W' : 'L';
    });

    return {
        nickname: CONFIG.playerNickname,
        elo: playerData.games.cs2.faceit_elo,
        level: playerData.games.cs2.skill_level,
        kdr: parseFloat(lifetimeStats["Average K/D Ratio"]) || 0,
        lastMatchId: matches[0]?.match_id || null,
        recentResults, // ["W", "L", "W", ...]
        ...last20Stats
    };
}

function calculateLast20Stats(allMatchStats, playerId, generalStats) {
    let totals = { win: 0, kills: 0, hs: 0, kd: 0, kr: 0, count: 0 };

    allMatchStats.forEach(matchData => {
        if (!matchData?.rounds) return;

        matchData.rounds.forEach(round => {
            round.teams.forEach(team => {
                const player = team.players?.find(p => p.player_id === playerId);
                if (player) {
                    const ps = player.player_stats;
                    totals.win += parseInt(ps.Result) === 1 ? 1 : 0;
                    totals.kills += parseInt(ps.Kills) || 0;
                    totals.hs += parseInt(ps["Headshots %"]) || 0;
                    totals.kd += parseFloat(ps["K/D Ratio"]) || 0;
                    totals.kr += parseFloat(ps["K/R Ratio"]) || 0;
                    totals.count++;
                }
            });
        });
    });

    if (totals.count === 0) {
        return {
            winrate: parseInt(generalStats["Win Rate %"]) || 0,
            avgKills: 0,
            hsPercent: parseInt(generalStats["Average Headshots %"]) || 0,
            kdRatio: parseFloat(generalStats["Average K/D Ratio"]) || 0,
            krRatio: 0
        };
    }

    return {
        winrate: Math.round((totals.win / totals.count) * 100),
        avgKills: totals.kills / totals.count,
        hsPercent: Math.round(totals.hs / totals.count),
        kdRatio: totals.kd / totals.count,
        krRatio: totals.kr / totals.count
    };
}
