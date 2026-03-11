const https = require('https');

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ body, statusCode: res.statusCode }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  const token = process.env.LEFIVE_TOKEN;
  const userId = process.env.LEFIVE_USER_ID;
  const reservationId = event.queryStringParameters?.reservationId;
  const matchId = event.queryStringParameters?.matchId;
  const getPlayers = event.queryStringParameters?.getPlayers === '1';

  if (!token || !userId) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Token manquant', ok: false }) };
  }

  const authHeaders = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    'Origin': 'https://lefive.fr',
  };

  try {

    // ── MODE : score + joueurs par matchId ──
    if (matchId) {
      const matchRes = await makeRequest(
        `https://api-front.lefive.fr/splf/v1/matches/${matchId}?appId=1`,
        { method: 'GET', headers: authHeaders }
      );
      const match = JSON.parse(matchRes.body);

      if (!match.id) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Match introuvable', ok: false }) };
      }

      let teamA = [];
      let teamB = [];

      if (getPlayers) {
        try {
          const playersRes = await makeRequest(
            `https://api-front.lefive.fr/splf/v1/matchplayers?match_id=${matchId}&appId=1`,
            { method: 'GET', headers: authHeaders }
          );
          const debug = event.queryStringParameters?.debug === '1';
          if (debug) {
            return { statusCode: 200, headers, body: JSON.stringify({
              debug: true,
              matchPlayersStatus: playersRes.statusCode,
              matchPlayersRaw: playersRes.body.substring(0, 2000),
              matchRaw: { firstTeam: match.firstTeam, secondTeam: match.secondTeam }
            })};
          }
          const players = JSON.parse(playersRes.body);
          const list = Array.isArray(players) ? players : (players.data || []);
          const firstTeamId = match.firstTeam?.id;
          const secondTeamId = match.secondTeam?.id;

          list.forEach((p, idx) => {
            const player = {
              firstName: p.firstName || p.first_name || '',
              lastName: p.lastName || p.last_name || '',
              name: p.name || `${p.firstName || ''} ${p.lastName || ''}`.trim(),
            };
            if (p.team?.id === firstTeamId || p.teamId === firstTeamId) {
              teamA.push(player);
            } else if (p.team?.id === secondTeamId || p.teamId === secondTeamId) {
              teamB.push(player);
            } else {
              if (idx % 2 === 0) teamA.push(player);
              else teamB.push(player);
            }
          });
        } catch(e) {}
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({
          ok: true,
          matchId: match.id,
          scoreA: match.firstTeamScore,
          scoreB: match.secondTeamScore,
          ended: match.ended,
          date: match.startingDate,
          affichage: `${match.firstTeamScore} - ${match.secondTeamScore}`,
          teamA,
          teamB,
        })
      };
    }

    // ── MODE : via reservationId ──
    if (!reservationId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'reservationId ou matchId requis', ok: false }) };
    }

    const now = new Date();
    const from = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();

    const bookingsRes = await makeRequest(
      `https://api-front.lefive.fr/splf/v1/bookings?owner_like=${userId}&from=${from}&to=${to}&_limit=100&appId=1&includeFixtureId=true`,
      { method: 'GET', headers: authHeaders }
    );

    const bookings = JSON.parse(bookingsRes.body);
    const list = Array.isArray(bookings) ? bookings : (bookings.data || bookings.bookings || []);
    const resa = list.find(b => String(b.id) === String(reservationId));

    if (!resa) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: `Réservation #${reservationId} introuvable`, ok: false }) };
    }

    const fixtureId = resa.fixtureId || resa.fixture_id || resa.matchId;
    const startDate = new Date(resa.startingDate || resa.date || 0);
    const isEnded = startDate < now;

    // Match terminé → score
    if (fixtureId && isEnded) {
      try {
        const matchRes = await makeRequest(
          `https://api-front.lefive.fr/splf/v1/matches/${fixtureId}?appId=1`,
          { method: 'GET', headers: authHeaders }
        );
        const match = JSON.parse(matchRes.body);
        if (match.id && match.ended) {
          return {
            statusCode: 200, headers,
            body: JSON.stringify({
              ok: true,
              reservationId,
              matchId: fixtureId,
              scoreA: match.firstTeamScore,
              scoreB: match.secondTeamScore,
              ended: true,
              affichage: `${match.firstTeamScore} - ${match.secondTeamScore}`,
              centre: match.center?.centerName || '',
              date: match.startingDate,
            })
          };
        }
      } catch(e) {}
    }

    // Match à venir → nombre de joueurs
    const inscrits = resa.nbOfPaidParticipations ?? resa.paidParticipants ?? 0;
    const total = resa.capacity ?? 10;
    const centre = resa.centerName || resa.center?.centerName || '';

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        ok: true,
        reservationId,
        fixtureId: fixtureId || null,
        inscrits,
        total,
        affichage: `${inscrits}/${total}`,
        status: resa.booking_status,
        centre,
        date: resa.startingDate || resa.date,
        isFull: inscrits >= total,
      })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, ok: false }) };
  }
};
