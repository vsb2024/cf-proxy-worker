export default {
  async fetch(request, env, ctx) {
    // Настройки
    const TARGET_ORIGIN = "https://casinoguards.com";
    const BASE_PATH = "/casino-en-ligne"; // на вашем домене
    const BLOCK_SEARCH_INDEXING = false; // Блокировать индексацию поисковиками
    const url = new URL(request.url);

    // Обрабатываем только наш префикс; прочее можно отдавать как есть/404
    if (!url.pathname.startsWith(BASE_PATH)) {
      return new Response("Not Found", { status: 404 });
    }

    // Строим целевой URL: /casino-en-ligne/foo -> https://casinoguards.com/casino-en-ligne/foo
    let upstreamPath = url.pathname; // используем полный путь как есть
    const upstreamUrl = new URL(upstreamPath + url.search, TARGET_ORIGIN);

    // Подготавливаем проксируемый запрос (метод/тело/заголовки)
    const reqHeaders = new Headers(request.headers);
    // Хостом при обращении к источнику должен быть домен источника
    reqHeaders.set("Host", new URL(TARGET_ORIGIN).host);
    // Удалим Accept-Encoding, чтобы упростить HTML-перепись (Cloudflare сам сожмёт)
    reqHeaders.delete("Accept-Encoding");

    const proxyRequest = new Request(upstreamUrl.toString(), {
      method: request.method,
      headers: reqHeaders,
      body: request.method === "GET" || request.method === "HEAD" ? null : await request.clone().arrayBuffer(),
      redirect: "manual"
    });

    const upstreamResp = await fetch(proxyRequest);

    // Перепишем Location при 30x
    if (upstreamResp.status >= 300 && upstreamResp.status < 400) {
      const loc = upstreamResp.headers.get("Location");
      if (loc) {
        const rewritten = rewriteAbsoluteToProxy(loc, TARGET_ORIGIN, BASE_PATH, url);
        const h = new Headers(upstreamResp.headers);
        h.set("Location", rewritten);
        return new Response(null, { status: upstreamResp.status, headers: h });
      }
      return upstreamResp;
    }

    // Переписать Set-Cookie (Domain=casinoguards.com -> Domain=casino-kit-prod.site)
    const outHeaders = new Headers(upstreamResp.headers);
    const setCookies = getAllSetCookie(outHeaders);
    if (setCookies.length) {
      // Очистим существующие и добавим переписанные
      outHeaders.delete("Set-Cookie");
      for (const sc of setCookies) {
        outHeaders.append("Set-Cookie", rewriteSetCookieDomain(sc, url.hostname));
      }
    }

    // Контент-тайп
    const contentType = upstreamResp.headers.get("Content-Type") || "";

    // HTML: переписываем ссылки и srcset
    if (contentType.includes("text/html")) {
      const rewriter = new HTMLRewriter()
        .on('a[href]', new AttrRewriter('href', TARGET_ORIGIN, BASE_PATH, url))
        .on('link[href]', new AttrRewriter('href', TARGET_ORIGIN, BASE_PATH, url))
        .on('script[src]', new AttrRewriter('src', TARGET_ORIGIN, BASE_PATH, url))
        .on('img[src]', new AttrRewriter('src', TARGET_ORIGIN, BASE_PATH, url))
        .on('form[action]', new AttrRewriter('action', TARGET_ORIGIN, BASE_PATH, url))
        .on('source[srcset]', new SrcSetRewriter('srcset', TARGET_ORIGIN, BASE_PATH, url))
        .on('img[srcset]', new SrcSetRewriter('srcset', TARGET_ORIGIN, BASE_PATH, url));

      // Добавляем meta robots для блокировки индексации
      if (BLOCK_SEARCH_INDEXING) {
        rewriter.on('head', new NoIndexInjector());
      }

      // Убираем защитные заголовки источника, чтобы не ломать встраивание
      sanitizeHeadersForProxy(outHeaders);

      // Добавляем X-Robots-Tag заголовок для блокировки индексации
      if (BLOCK_SEARCH_INDEXING) {
        outHeaders.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
      }

      return rewriter.transform(new Response(upstreamResp.body, {
        status: upstreamResp.status,
        headers: outHeaders
      }));
    }

    // CSS: иногда полезно переписать url(/...) => url(/casino-en-ligne/...)
    if (contentType.includes("text/css")) {
      const css = await upstreamResp.text();
      const rewrittenCss = css
        // Заменяем только пути, которые еще не начинаются с basePath
        .replaceAll(/\burl\((['"]?)\/(?!casino-en-ligne|\/)/g, `url($1${BASE_PATH}/`)
        .replaceAll(new RegExp(escapeRegExp(TARGET_ORIGIN) + "(?!" + escapeRegExp(BASE_PATH) + ")", "g"), ``);
      sanitizeHeadersForProxy(outHeaders);
      outHeaders.set("Content-Length", String(new TextEncoder().encode(rewrittenCss).length));
      return new Response(rewrittenCss, { status: upstreamResp.status, headers: outHeaders });
    }

    // Остальные типы — просто проксируем
    sanitizeHeadersForProxy(outHeaders);
    return new Response(upstreamResp.body, { status: upstreamResp.status, headers: outHeaders });
  }
};

// === Вспомогательные функции ===

// Переписать абсолютный/корневой URL под наш префикс
function rewriteAbsoluteToProxy(href, targetOrigin, basePath, reqUrlObj) {
  try {
    const u = new URL(href, targetOrigin);
    const t = new URL(targetOrigin);
    // Если ссылка ведёт на исходный домен — оставляем как есть (путь уже содержит /casino-en-ligne/)
    if (u.origin === t.origin) {
      // Проверяем, не начинается ли путь уже с basePath
      if (u.pathname.startsWith(basePath)) {
        return u.pathname + (u.search || "") + (u.hash || "");
      }
      return basePath + (u.pathname.startsWith("/") ? u.pathname : `/${u.pathname}`) + (u.search || "") + (u.hash || "");
    }
    // Если ссылка корневая (когда href начинался с "/")
    if (href.startsWith("/")) {
      // Проверяем, не начинается ли путь уже с basePath
      if (href.startsWith(basePath)) {
        return href;
      }
      return basePath + href;
    }
    // Иное — оставляем как есть (внешние домены)
    return href;
  } catch {
    // относительные без протокола и т.д.
    if (href.startsWith("/")) {
      // Проверяем, не начинается ли путь уже с basePath
      if (href.startsWith(basePath)) {
        return href;
      }
      return basePath + href;
    }
    // относительные ссылки оставляем — браузер сам разрешит относительно текущего пути
    return href;
  }
}

class AttrRewriter {
  constructor(attr, targetOrigin, basePath, reqUrlObj) {
    this.attr = attr;
    this.targetOrigin = targetOrigin;
    this.basePath = basePath;
    this.reqUrlObj = reqUrlObj;
  }
  element(el) {
    const val = el.getAttribute(this.attr);
    if (!val) return;
    el.setAttribute(this.attr, rewriteAbsoluteToProxy(val, this.targetOrigin, this.basePath, this.reqUrlObj));
  }
}

class SrcSetRewriter {
  constructor(attr, targetOrigin, basePath, reqUrlObj) {
    this.attr = attr;
    this.targetOrigin = targetOrigin;
    this.basePath = basePath;
    this.reqUrlObj = reqUrlObj;
  }
  element(el) {
    const val = el.getAttribute(this.attr);
    if (!val) return;
    const parts = val.split(",").map(s => s.trim()).map(entry => {
      const [urlPart, sizePart] = entry.split(/\s+/, 2);
      const newUrl = rewriteAbsoluteToProxy(urlPart, this.targetOrigin, this.basePath, this.reqUrlObj);
      return sizePart ? `${newUrl} ${sizePart}` : newUrl;
    });
    el.setAttribute(this.attr, parts.join(", "));
  }
}

class NoIndexInjector {
  element(el) {
    el.append('<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">', { html: true });
  }
}

function sanitizeHeadersForProxy(h) {
  h.delete("Content-Security-Policy");
  h.delete("X-Frame-Options");
  h.delete("X-Content-Security-Policy");
  h.delete("X-WebKit-CSP");
  // Браузеру сам определить размер после модификаций
  h.delete("Content-Length");
}

function getAllSetCookie(headers) {
  // В Workers доступен headers.getAll в среде CF
  if (typeof headers.getAll === "function") {
    return headers.getAll("Set-Cookie") || [];
  }
  // Fallback: некоторые среды объединяют через запятую (не всегда корректно, но попробуем)
  const one = headers.get("Set-Cookie");
  if (!one) return [];
  // Разделение на основе ", " между cookie, где у атрибутов даты тоже есть запятые — поэтому лучше не сплитить вслепую.
  // Здесь простой вариант: если есть последовательные "Path=" или "Domain=" — сплитим по "], " — но это ненадёжно.
  // Для CF достаточно getAll; fallback оставим как один cookie.
  return [one];
}

function rewriteSetCookieDomain(sc, newDomain) {
  // Меняем/добавляем Domain
  const parts = sc.split(";").map(p => p.trim());
  let hasDomain = false;
  const out = parts.map(p => {
    if (/^Domain=/i.test(p)) {
      hasDomain = true;
      return `Domain=${newDomain}`;
    }
    return p;
  });
  if (!hasDomain) {
    out.push(`Domain=${newDomain}`);
  }
  // Безопасность: гарантируем SameSite=Lax, если не указано
  if (!out.some(p => /^SameSite=/i.test(p))) {
    out.push("SameSite=Lax");
  }
  return out.join("; ");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
