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
        const firstTeamId = match.firstTeam?.id;
        const secondTeamId = match.secondTeam?.id;

        const fetchTeamPlayers = async (teamId) => {
          try {
            // Essai 1 : /teams/{id}/players
            let res = await makeRequest(
              `https://api-front.lefive.fr/splf/v1/teams/${teamId}/players?appId=1`,
              { method: 'GET', headers: authHeaders }
            );
            let data = JSON.parse(res.body);
            if (res.statusCode === 200 && (Array.isArray(data) || data.data)) {
              const list = Array.isArray(data) ? data : data.data;
              return list.map(p => ({
                firstName: p.firstName || p.first_name || p.name?.split(' ')[0] || '',
                lastName: p.lastName || p.last_name || p.name?.split(' ').slice(1).join(' ') || '',
              }));
            }
            // Essai 2 : /matchteamplayers?team_id={id}&match_id={matchId}
            res = await makeRequest(
              `https://api-front.lefive.fr/splf/v1/matchteamplayers?team_id=${teamId}&match_id=${matchId}&appId=1`,
              { method: 'GET', headers: authHeaders }
            );
            data = JSON.parse(res.body);
            if (res.statusCode === 200 && (Array.isArray(data) || data.data)) {
              const list = Array.isArray(data) ? data : data.data;
              return list.map(p => ({
                firstName: p.firstName || p.first_name || p.name?.split(' ')[0] || p.player?.firstName || '',
                lastName: p.lastName || p.last_name || p.name?.split(' ').slice(1).join(' ') || p.player?.lastName || '',
              }));
            }
          } catch(e) {}
          return [];
        };

        const debug = event.queryStringParameters?.debug === '1';
        if (debug) {
          const r1 = await makeRequest(`https://api-front.lefive.fr/splf/v1/teams/${firstTeamId}/players?appId=1`, { method: 'GET', headers: authHeaders });
          const r2 = await makeRequest(`https://api-front.lefive.fr/splf/v1/matchteamplayers?team_id=${firstTeamId}&match_id=${matchId}&appId=1`, { method: 'GET', headers: authHeaders });
          return { statusCode: 200, headers, body: JSON.stringify({
            debug: true, firstTeamId, secondTeamId,
            teamsPlayers_status: r1.statusCode, teamsPlayers_raw: r1.body.substring(0, 500),
            matchTeamPlayers_status: r2.statusCode, matchTeamPlayers_raw: r2.body.substring(0, 500),
          })};
        }

        if (firstTeamId) teamA = await fetchTeamPlayers(firstTeamId);
        if (secondTeamId) teamB = await fetchTeamPlayers(secondTeamId);
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
