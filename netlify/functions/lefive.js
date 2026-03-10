const https = require('https');

function request(hostname, path, method = 'GET', headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ json: JSON.parse(data), status: res.statusCode }); }
        catch(e) { resolve({ json: null, raw: data, status: res.statusCode }); }
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
    // 1. Login via le bon endpoint
    const formBody = `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;

    const loginRes = await request(
      'api2-front.lefive.fr',
      '/login/client?appId=1&isChannelWeb=true',
      'POST',
      {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formBody),
        'Accept': 'text/plain, */*',
        'Origin': 'https://www.lefive.fr',
        'Referer': 'https://www.lefive.fr/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      },
      formBody
    );

    // Le token peut être dans json.token, json.accessToken, ou directement dans raw
    const token = loginRes.json?.token || loginRes.json?.accessToken || loginRes.json?.id_token || loginRes.raw;
    const userId = loginRes.json?.id || loginRes.json?.userId || loginRes.json?.user?.id || 1623729;

    if (!token || token.length < 20) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Login échoué', detail: loginRes.raw?.substring(0, 200), ok: false }) };
    }

    // 2. Récupérer les réservations
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
    const bookingsPath = `/splf/v1/bookings?owner_like=${userId}&from=${from}&to=${to}&_limit=20&appId=1&includeFixtureId=true`;

    const bookingsRes = await request(
      'api-front.lefive.fr',
      bookingsPath,
      'GET',
      {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Origin': 'https://www.lefive.fr',
        'Referer': 'https://www.lefive.fr/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      }
    );

    if (!Array.isArray(bookingsRes.json)) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Réponse inattendue', detail: bookingsRes.raw?.substring(0, 200), ok: false }) };
    }

    const bookings = bookingsRes.json;

    // 3. Chercher la réservation par ID
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

    // 4. Sans ID : retourner toutes les réservations à venir confirmées
    const upcoming = bookings
      .filter(b => b.booking_status === 'Confirmed' && new Date(b.startingDate) > now)
      .map(b => ({
        id: b.id,
        inscrits: b.nbOfPaidParticipations,
        total: b.capacity,
        affichage: `${b.nbOfPaidParticipations}/${b.capacity}`,
        centre: b.center?.centerName,
        date: b.startingDate,
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
