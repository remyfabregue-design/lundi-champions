const https = require('https');
const http = require('http');

// Fonction utilitaire pour faire des requêtes HTTP
function makeRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const protocol = options.protocol === 'http:' ? http : https;
    const req = protocol.request(options, (res) => {
      let body = '';
      const cookies = res.headers['set-cookie'] || [];
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ body, headers: res.headers, cookies, statusCode: res.statusCode }));
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  const email = process.env.LEFIVE_EMAIL;
  const password = process.env.LEFIVE_PASSWORD;
  const reservationId = event.queryStringParameters?.reservationId || '9544177';

  if (!email || !password) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Identifiants manquants' })
    };
  }

  try {
    // 1. Récupérer le token CSRF
    const loginPage = await makeRequest({
      hostname: 'lefive.fr',
      path: '/connexion',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9',
      }
    });

    // Extraire le token CSRF
    const csrfMatch = loginPage.body.match(/name="_token"\s+value="([^"]+)"/);
    const csrfToken = csrfMatch ? csrfMatch[1] : null;

    // Récupérer les cookies de session
    const sessionCookies = loginPage.cookies.map(c => c.split(';')[0]).join('; ');

    if (!csrfToken) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Impossible de récupérer le token CSRF' })
      };
    }

    // 2. Se connecter
    const postData = new URLSearchParams({
      _token: csrfToken,
      email: email,
      password: password,
    }).toString();

    const loginRes = await makeRequest({
      hostname: 'lefive.fr',
      path: '/connexion',
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'Cookie': sessionCookies,
        'Referer': 'https://lefive.fr/connexion',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
      }
    }, postData);

    // Récupérer les nouveaux cookies après login
    const authCookies = [
      ...loginPage.cookies,
      ...(loginRes.cookies || [])
    ].map(c => c.split(';')[0]).join('; ');

    // 3. Accéder à la page des réservations
    const resaPage = await makeRequest({
      hostname: 'lefive.fr',
      path: '/mon-compte/mes-resa',
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Cookie': authCookies,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Referer': 'https://lefive.fr/',
      }
    });

    const html = resaPage.body;

    // 4. Chercher la réservation par son numéro
    // On cherche le bloc contenant le numéro de réservation
    const resaPattern = new RegExp(
      `#${reservationId}[\\s\\S]{0,2000}?Parts payées[\\s\\S]{0,200}?(\\d+)\\s*/\\s*(\\d+)`,
      'i'
    );
    const match = html.match(resaPattern);

    if (match) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          reservationId,
          inscrits: parseInt(match[1]),
          total: parseInt(match[2]),
          affichage: `${match[1]}/${match[2]}`,
          ok: true
        })
      };
    }

    // Fallback : chercher "Parts payées" de façon générique
    const partsMatch = html.match(/Parts payées[\s\S]{0,100}?(\d+)\s*\/\s*(\d+)/i);
    if (partsMatch) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          reservationId,
          inscrits: parseInt(partsMatch[1]),
          total: parseInt(partsMatch[2]),
          affichage: `${partsMatch[1]}/${partsMatch[2]}`,
          ok: true
        })
      };
    }

    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: 'Réservation introuvable ou format inattendu', ok: false })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message, ok: false })
    };
  }
};
