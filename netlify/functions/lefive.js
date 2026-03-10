const https = require('https');

function makeRequest(options, postData = null, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) && res.headers.location && maxRedirects > 0) {
        const location = res.headers.location;
        const url = new URL(location.startsWith('http') ? location : `https://${options.hostname}${location}`);
        const newOptions = {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: 'GET',
          headers: { ...options.headers, 'Host': url.hostname }
        };
        const cookies = res.headers['set-cookie'] || [];
        makeRequest(newOptions, null, maxRedirects - 1).then(result => {
          result.cookies = [...cookies, ...(result.cookies || [])];
          resolve(result);
        }).catch(reject);
        return;
      }
      let body = '';
      const cookies = res.headers['set-cookie'] || [];
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ body, headers: res.headers, cookies, statusCode: res.statusCode }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (postData) req.write(postData);
    req.end();
  });
}

function parseCookies(cookieArray) {
  return cookieArray.map(c => c.split(';')[0]).join('; ');
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
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Identifiants manquants', ok: false }) };
  }

  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Linux"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0',
  };

  try {
    // 1. Charger la page de connexion
    const loginPageRes = await makeRequest({
      hostname: 'lefive.fr',
      path: '/connexion',
      method: 'GET',
      headers: baseHeaders
    });

    const allCookies = loginPageRes.cookies;
    const cookieStr = parseCookies(allCookies);
    const html1 = loginPageRes.body;

    // Extraire le token CSRF
    let csrfToken = '';
    const patterns = [
      /name="_token"\s+value="([^"]+)"/,
      /value="([^"]+)"\s+name="_token"/,
      /"_token"\s*:\s*"([^"]+)"/,
      /<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i,
    ];
    for (const p of patterns) {
      const m = html1.match(p);
      if (m) { csrfToken = m[1]; break; }
    }

    // 2. Connexion
    const formData = new URLSearchParams({
      _token: csrfToken,
      email,
      password,
      remember: 'on'
    }).toString();

    const loginRes = await makeRequest({
      hostname: 'lefive.fr',
      path: '/connexion',
      method: 'POST',
      headers: {
        ...baseHeaders,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(formData),
        'Cookie': cookieStr,
        'Referer': 'https://lefive.fr/connexion',
        'Origin': 'https://lefive.fr',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
      }
    }, formData);

    const authCookies = parseCookies([...allCookies, ...(loginRes.cookies || [])]);

    // 3. Page des réservations
    const resaRes = await makeRequest({
      hostname: 'lefive.fr',
      path: '/mon-compte/mes-resa',
      method: 'GET',
      headers: {
        ...baseHeaders,
        'Cookie': authCookies,
        'Referer': 'https://lefive.fr/',
        'Sec-Fetch-Site': 'same-origin',
      }
    });

    const resaHtml = resaRes.body;

    // 4. Extraire les participants
    const resaBlockPattern = new RegExp(
      `#${reservationId}[\\s\\S]{0,3000}?Parts payées[\\s\\S]{0,300}?(\\d+)\\s*/\\s*(\\d+)`,
      'i'
    );
    let match = resaHtml.match(resaBlockPattern);

    if (!match) {
      const fallback = /Parts payées[\s\S]{0,200}?(\d+)\s*\/\s*(\d+)/i;
      match = resaHtml.match(fallback);
    }

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

    // Mode debug: retourner un extrait pour diagnostiquer
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: false,
        debug: true,
        statusCode: resaRes.statusCode,
        snippet: resaHtml.substring(0, 1000),
        hasParts: resaHtml.includes('Parts'),
        hasResa: resaHtml.includes(reservationId),
        isLoggedIn: resaHtml.includes('Mon compte') || resaHtml.includes('Déconnexion') || resaHtml.includes('mes-resa')
      })
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack, ok: false }) };
  }
};
