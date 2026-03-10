const https = require('https');

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ json: JSON.parse(data), status: res.statusCode, headers: res.headers }); }
        catch(e) { resolve({ json: null, raw: data, status: res.statusCode, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  const email = process.env.LEFIVE_EMAIL;
  const password = process.env.LEFIVE_PASSWORD;
  const reservationId = event.queryStringParameters?.reservationId;

  if (!email || !password) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Identifiants manquants', ok: false }) };
  }

  try {
    // 1. Authentification via l'API LeFive
    const loginBody = JSON.stringify({ username: email, password });
    const loginRes = await request(
      'https://api-front.lefive.fr/splf/v1/authenticate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://www.lefive.fr',
          'Referer': 'https://www.lefive.fr/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        }
      },
      loginBody
    );

    if (!loginRes.json?.token) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Connexion LeFive échouée', detail: loginRes.raw, ok: false }) };
    }

    const token = loginRes.json.token;
    const userId = loginRes.json.id || loginRes.json.userId;

    // 2. Récupérer les réservations
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(); // -7 jours
    const to = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString(); // +6 mois

    const bookingsUrl = `https://api-front.lefive.fr/splf/v1/bookings?owner_like=${userId}&from=${from}&to=${to}&_limit=20&appId=1&includeFixtureId=true`;

    const bookingsRes = await request(bookingsUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Origin': 'https://www.lefive.fr',
        'Referer': 'https://www.lefive.fr/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      }
    });

    if (!Array.isArray(bookingsRes.json)) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Réponse inattendue', detail: bookingsRes.raw, ok: false }) };
    }

    const bookings = bookingsRes.json;

    // 3. Si un reservationId est fourni, chercher cette résa précise
    if (reservationId) {
      const resa = bookings.find(b => String(b.id) === String(reservationId));
      if (!resa) {
        return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: `Réservation #${reservationId} introuvable`, ok: false }) };
      }
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: true,
          reservationId: resa.id,
          inscrits: resa.nbOfPaidParticipations,
          total: resa.capacity,
          affichage: `${resa.nbOfPaidParticipations}/${resa.capacity}`,
          status: resa.booking_status,
          centre: resa.center?.centerName,
          date: resa.startingDate,
        })
      };
    }

    // 4. Sans reservationId, retourner toutes les réservations à venir (confirmées)
    const upcoming = bookings
      .filter(b => b.booking_status === 'Confirmed' && new Date(b.startingDate) > now)
      .map(b => ({
        id: b.id,
        inscrits: b.nbOfPaidParticipations,
        total: b.capacity,
        affichage: `${b.nbOfPaidParticipations}/${b.capacity}`,
        centre: b.center?.centerName,
        date: b.startingDate,
        status: b.booking_status,
      }));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ ok: true, bookings: upcoming })
    };

  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message, ok: false }) };
  }
};
