const https = require('https');

function request(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ json: JSON.parse(data), status: res.statusCode }); }
        catch(e) { resolve({ json: null, raw: data, status: res.statusCode }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  const token = process.env.LEFIVE_TOKEN;
  const userId = process.env.LEFIVE_USER_ID || '1623729';
  const reservationId = event.queryStringParameters?.reservationId;

  if (!token) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Token manquant', ok: false }) };
  }

  try {
    const now = new Date();
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000).toISOString();
    const path = `/splf/v1/bookings?owner_like=${userId}&from=${from}&to=${to}&_limit=20&appId=1&includeFixtureId=true`;

    const res = await request(
      'api-front.lefive.fr',
      path,
      {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Origin': 'https://www.lefive.fr',
        'Referer': 'https://www.lefive.fr/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      }
    );

    if (!Array.isArray(res.json)) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Réponse inattendue', detail: res.raw?.substring(0, 200), ok: false }) };
    }

    const bookings = res.json;

    // Chercher une réservation spécifique
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

    // Sans ID : toutes les réservations confirmées à venir
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
