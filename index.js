/**
 * earnity-seo — Cloudflare Worker
 *
 * Serves SEO-optimized HTML for /p/:productId-:slug and /s/:storeName by
 * taking the site's existing static HTML shell and injecting <head> tags,
 * JSON-LD and a screen-reader-only content block from D1.
 * Also serves /sitemap*.xml.
 *
 * READ-ONLY on D1. Never mutates the database. Same HTML for every visitor.
 */

const PRODUCTS_PER_SITEMAP = 40000;
const CLOUDINARY_ID_RE = /^[a-zA-Z0-9_\-\/]{1,200}$/;
const PRODUCT_ID_RE = /^[A-Za-z0-9_]{1,128}$/;
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])?$/i;
const SITEMAP_CACHE = "public, max-age=300, s-maxage=3600";
const PAGE_CACHE = "public, max-age=60, s-maxage=300";
const SR_ONLY_STYLE = "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap";

/* ------------------------------------------------------------------ */
/* Errors                                                             */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* Escaping / formatting                                              */
/* ------------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&#39;" : "&quot;"
  );
}

function escapeXml(s) {
  return String(s == null ? "" : s).replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;"
  );
}

function collapseWs(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

function formatPrice(ugx) {
  const n = Math.round(Number(ugx));
  if (!Number.isFinite(n) || n < 0) return "UGX 0";
  return "UGX " + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function lastmodDate(unixSec) {
  const n = Number(unixSec);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString().slice(0, 10);
}

/** Cut a whitespace-collapsed string at a word boundary, without ellipsis. */
function cutAtWord(input, maxLen) {
  const s = collapseWs(input);
  if (s.length <= maxLen) return s;
  let cut = maxLen;
  const space = s.lastIndexOf(" ", cut);
  if (space > 0) cut = space;
  return s.slice(0, cut).replace(/[\s,;.:!?\-]+$/, "");
}

/** slugify: lowercase ASCII, non-alnum -> '-', collapse, trim, max 60, fallback "item". */
function slugify(name) {
  if (typeof name !== "string") return "item";
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > 60) s = s.slice(0, 60).replace(/-+$/g, "");
  return s || "item";
}

/* ------------------------------------------------------------------ */
/* JSON / script safety                                               */
/* ------------------------------------------------------------------ */

function jsonLdSafe(obj) {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function jsSafeJsonString(s) {
  return JSON.stringify(String(s)).replace(/</g, "\\u003c");
}

/* ------------------------------------------------------------------ */
/* Data helpers                                                       */
/* ------------------------------------------------------------------ */

function effectivePrice(product, now) {
  const op = product.offer_price_ugx;
  const os = product.offer_starts_at;
  const oe = product.offer_ends_at;
  const active =
    op != null && os != null && oe != null &&
    Number(os) <= now && now < Number(oe);
  return {
    price: active ? Number(op) : Number(product.price_ugx),
    offerActive: active,
    offerEndsAt: active ? Number(oe) : null,
  };
}

function parseImageIds(raw) {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((id) => typeof id === "string" && CLOUDINARY_ID_RE.test(id))
      .slice(0, 6);
  } catch {
    return [];
  }
}

function cloudinaryUrl(publicId, env, opts = {}) {
  if (!publicId || !CLOUDINARY_ID_RE.test(publicId)) return null;
  const w = opts.w || 1200;
  const h = opts.h || 630;
  const crop = opts.crop || "c_fill";
  const fmt = opts.format || "f_jpg";
  return `https://res.cloudinary.com/${env.CLOUD_NAME}/image/upload/${fmt},q_auto,w_${w},h_${h},${crop}/${publicId}`;
}

function splitParagraphs(text) {
  if (!text) return [];
  return String(text).split(/\n+/).map((s) => s.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* Title / meta-description builders                                  */
/* ------------------------------------------------------------------ */

function productTitle(name, priceStr, storeName) {
  const full = `${name} – ${priceStr} | ${storeName} on Earnity`;
  if (full.length <= 65) return full;
  const short = `${name} – ${priceStr}`;
  if (short.length <= 65) return short;
  return short.slice(0, 64).trimEnd() + "…";
}

function productMetaDesc(desc, storeName) {
  const suffix = ` Buy from ${storeName} on Earnity, Uganda.`;
  const budget = 160 - suffix.length;
  const target = Math.min(110, budget);
  let prefix = cutAtWord(desc || "", target);
  if (prefix && !/[.!?]$/.test(prefix)) prefix += ".";
  return (prefix + suffix).trim();
}

function storeTitle(storeName) {
  const full = `${storeName} – Online Store on Earnity`;
  if (full.length <= 65) return full;
  return full.slice(0, 64).trimEnd() + "…";
}

function storeMetaDesc(desc, storeName) {
  const suffix = ` Shop ${storeName} on Earnity, Uganda.`;
  const budget = 160 - suffix.length;
  const target = Math.min(120, budget);
  let prefix = cutAtWord(desc || "", target);
  if (prefix && !/[.!?]$/.test(prefix)) prefix += ".";
  return (prefix + suffix).trim();
}

/* ------------------------------------------------------------------ */
/* HTMLRewriter helpers                                               */
/* ------------------------------------------------------------------ */

function attachCommonRemovers(rewriter) {
  rewriter
    .on("head > title", { element: (el) => el.remove() })
    .on('meta[name="description"]', { element: (el) => el.remove() })
    .on('link[rel="canonical"]', { element: (el) => el.remove() })
    .on('meta[property^="og:"]', { element: (el) => el.remove() })
    .on('meta[name^="twitter:"]', { element: (el) => el.remove() })
    .on('meta[name="robots"]', { element: (el) => el.remove() });
}

function attachHeadAppend(rewriter, html) {
  rewriter.on("head", {
    element(el) { el.append(html, { html: true }); },
  });
}

function attachBodyPrepend(rewriter, html) {
  rewriter.on("body", {
    element(el) { el.prepend(html, { html: true }); },
  });
}

/* ------------------------------------------------------------------ */
/* SEO builders                                                       */
/* ------------------------------------------------------------------ */

function buildProductSeo({ product, price, offerActive, offerEndsAt, imageIds, ogImage, env }) {
  const storeName = product.b_name;
  const storeSlug = String(product.subdomain || "").toLowerCase();
  const storeUrl = `${env.SITE_ORIGIN}/s/${storeSlug}`;
  const productSlug = slugify(product.name);
  const productPath = `/p/${product.id}-${productSlug}`;
  const productUrl = env.SITE_ORIGIN + productPath;
  const priceStr = formatPrice(price);
  const title = productTitle(product.name, priceStr, storeName);
  const description = productMetaDesc(product.description, storeName);
  const images = imageIds
    .map((id) => cloudinaryUrl(id, env, { w: 1200, h: 1200, crop: "c_fill" }))
    .filter(Boolean);

  /* --- JSON-LD Product --- */
  const productLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: product.name,
    description: collapseWs(product.description || "").slice(0, 500),
    image: images.length > 0 ? images : [ogImage],
    sku: product.id,
    url: productUrl,
    offers: {
      "@type": "Offer",
      price: price,
      priceCurrency: "UGX",
      availability: "https://schema.org/InStock",
      url: productUrl,
      seller: { "@type": "Organization", name: storeName },
    },
  };
  if (offerActive && offerEndsAt) {
    productLd.offers.priceValidUntil = new Date(offerEndsAt * 1000).toISOString().slice(0, 10);
  }

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: env.SITE_ORIGIN + "/" },
      { "@type": "ListItem", position: 2, name: storeName, item: storeUrl },
      { "@type": "ListItem", position: 3, name: product.name },
    ],
  };

  /* --- <head> --- */
  const head = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(productUrl)}">`,
    `<meta name="robots" content="index, follow, max-image-preview:large">`,
    `<meta property="og:type" content="product">`,
    `<meta property="og:site_name" content="Earnity">`,
    `<meta property="og:url" content="${escapeHtml(productUrl)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:image" content="${escapeHtml(ogImage)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${escapeHtml(product.name)}">`,
    `<meta property="product:price:amount" content="${price}">`,
    `<meta property="product:price:currency" content="UGX">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${escapeHtml(ogImage)}">`,
    `<script>window.__EARNITY_PRODUCT__=${jsSafeJsonString(product.id)};</script>`,
    `<script type="application/ld+json">${jsonLdSafe(productLd)}</script>`,
    `<script type="application/ld+json">${jsonLdSafe(breadcrumbLd)}</script>`,
  ].join("");

  /* --- sr-only body block --- */
  const body = [];
  body.push(`<div class="sr-only-seo" style="${SR_ONLY_STYLE}">`);
  body.push(`<h1>${escapeHtml(product.name)}</h1>`);
  body.push(`<p>${escapeHtml(priceStr)}</p>`);
  for (const para of splitParagraphs(product.description)) {
    body.push(`<p>${escapeHtml(para)}</p>`);
  }
  body.push(`<p>Sold by <a href="/s/${escapeHtml(storeSlug)}">${escapeHtml(storeName)}</a></p>`);
  if (product.delivery_text) {
    body.push(`<p>Delivery: ${escapeHtml(product.delivery_text)}</p>`);
  }
  for (const id of imageIds) {
    const src = cloudinaryUrl(id, env, { w: 600, h: 600, crop: "c_fill", format: "f_auto" });
    if (src) body.push(`<img src="${escapeHtml(src)}" alt="${escapeHtml(product.name)}">`);
  }
  body.push(`</div>`);

  return { headHtml: head, bodyHtml: body.join("") };
}

function buildStoreSeo({ business, products, env, now, canonicalUrl }) {
  const storeName = business.name;
  const subdomain = String(business.subdomain).toLowerCase();
  const title = storeTitle(storeName);
  const description = storeMetaDesc(business.description, storeName);

  /* og:image: banner, else logo, else default */
  let ogImage = env.DEFAULT_OG_IMAGE;
  if (business.banner_public_id) {
    ogImage = cloudinaryUrl(business.banner_public_id, env, { w: 1200, h: 630 }) || ogImage;
  } else if (business.logo_public_id) {
    ogImage = cloudinaryUrl(business.logo_public_id, env, { w: 1200, h: 630 }) || ogImage;
  }

  const logoUrl = business.logo_public_id
    ? cloudinaryUrl(business.logo_public_id, env, { w: 512, h: 512, crop: "c_fit" })
    : null;
  const bannerUrl = business.banner_public_id
    ? cloudinaryUrl(business.banner_public_id, env, { w: 1200, h: 630 })
    : null;

  const hasProducts = products.length > 0;
  const robots = hasProducts
    ? "index, follow, max-image-preview:large"
    : "noindex, follow";

  const storeLd = {
    "@context": "https://schema.org",
    "@type": "OnlineStore",
    name: storeName,
    description: collapseWs(business.description || "").slice(0, 500),
    url: canonicalUrl,
  };
  if (logoUrl) storeLd.logo = logoUrl;
  if (bannerUrl) storeLd.image = bannerUrl;

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: env.SITE_ORIGIN + "/" },
      { "@type": "ListItem", position: 2, name: storeName },
    ],
  };

  const head = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}">`,
    `<meta name="robots" content="${escapeHtml(robots)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Earnity">`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:image" content="${escapeHtml(ogImage)}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:alt" content="${escapeHtml(storeName)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${escapeHtml(ogImage)}">`,
    `<script>window.__EARNITY_STORE__=${jsSafeJsonString(subdomain)};</script>`,
    `<script type="application/ld+json">${jsonLdSafe(storeLd)}</script>`,
    `<script type="application/ld+json">${jsonLdSafe(breadcrumbLd)}</script>`,
  ].join("");

  const body = [];
  body.push(`<div class="sr-only-seo" style="${SR_ONLY_STYLE}">`);
  body.push(`<h1>${escapeHtml(storeName)}</h1>`);
  for (const para of splitParagraphs(business.description)) {
    body.push(`<p>${escapeHtml(para)}</p>`);
  }
  if (business.delivery_text) {
    body.push(`<p>Delivery: ${escapeHtml(business.delivery_text)}</p>`);
  }
  if (hasProducts) {
    body.push(`<ul>`);
    for (const p of products) {
      const { price } = effectivePrice(p, now);
      body.push(
        `<li><a href="/p/${escapeHtml(p.id)}-${escapeHtml(slugify(p.name))}">${escapeHtml(p.name)} – ${escapeHtml(formatPrice(price))}</a></li>`
      );
    }
    body.push(`</ul>`);
  }
  body.push(`</div>`);

  return { headHtml: head, bodyHtml: body.join("") };
}

/* ------------------------------------------------------------------ */
/* Responses                                                          */
/* ------------------------------------------------------------------ */

function xmlResponse(xml) {
  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": SITEMAP_CACHE,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": PAGE_CACHE,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function redirectResponse(location) {
  return new Response(null, {
    status: 301,
    headers: {
      Location: location,
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function sitemapError() {
  return new Response("Service Unavailable", {
    status: 503,
    headers: {
      "Retry-After": "300",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Real 404: fetch /404.html and return it with a 404 status. */
async function serve404(env) {
  try {
    const res = await fetch(env.SITE_ORIGIN + "/404.html", { redirect: "follow" });
    if (res.status < 500) {
      const body = await res.arrayBuffer();
      if (body.byteLength > 0) {
        return new Response(body, {
          status: 404,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "X-Robots-Tag": "noindex",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store",
          },
        });
      }
    }
  } catch { /* ignore */ }
  return new Response("Not Found", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Robots-Tag": "noindex",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}

/** Fail-open for product pages: return the shell, unmodified, no-store. */
async function failOpenProduct(env) {
  try {
    const res = await fetch(env.SITE_ORIGIN + "/", { redirect: "follow" });
    if (res.ok) {
      const body = await res.arrayBuffer();
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  } catch { /* ignore */ }
  return new Response("Service Unavailable", {
    status: 503,
    headers: { "Retry-After": "60", "X-Content-Type-Options": "nosniff" },
  });
}

/** Fail-open for store pages: prefer /store, then /store.html, then /. */
async function failOpenStore(env) {
  for (const path of ["/store", "/store.html", "/"]) {
    try {
      const res = await fetch(env.SITE_ORIGIN + path, { redirect: "follow" });
      if (res.ok) {
        const body = await res.arrayBuffer();
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }
    } catch { /* try next */ }
  }
  return new Response("Service Unavailable", {
    status: 503,
    headers: { "Retry-After": "60", "X-Content-Type-Options": "nosniff" },
  });
}

/* ------------------------------------------------------------------ */
/* Sitemaps                                                           */
/* ------------------------------------------------------------------ */

async function handleSitemapIndex(env) {
  try {
    const [stores, products] = await Promise.all([
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM businesses b
         WHERE b.approval_status = 'approved'
           AND EXISTS (SELECT 1 FROM products p
                       WHERE p.business_id = b.id AND p.status = 'active')`
      ).first(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM products p
         JOIN businesses b ON b.id = p.business_id
         WHERE p.status = 'active' AND b.approval_status = 'approved'`
      ).first(),
    ]);
    const storePages = Math.max(1, Math.ceil(Number(stores?.n || 0) / PRODUCTS_PER_SITEMAP));
    const productPages = Math.max(1, Math.ceil(Number(products?.n || 0) / PRODUCTS_PER_SITEMAP));

    const entries = [];
    entries.push(`<sitemap><loc>${escapeXml(env.SITE_ORIGIN + "/sitemap-pages.xml")}</loc></sitemap>`);
    for (let i = 1; i <= storePages; i++) {
      entries.push(`<sitemap><loc>${escapeXml(`${env.SITE_ORIGIN}/sitemap-stores-${i}.xml`)}</loc></sitemap>`);
    }
    for (let i = 1; i <= productPages; i++) {
      entries.push(`<sitemap><loc>${escapeXml(`${env.SITE_ORIGIN}/sitemap-products-${i}.xml`)}</loc></sitemap>`);
    }

    return xmlResponse(
      `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</sitemapindex>`
    );
  } catch (err) {
    console.error("sitemap_index_error", err?.message);
    return sitemapError();
  }
}

function handleSitemapPages(env) {
  const pages = ["/", "/contact", "/terms", "/privacy", "/seller-terms"];
  const entries = pages.map(
    (p) => `<url><loc>${escapeXml(env.SITE_ORIGIN + p)}</loc></url>`
  );
  return xmlResponse(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>`
  );
}

async function handleSitemapStores(env, page) {
  if (!Number.isInteger(page) || page < 1) return serve404(env);
  const offset = (page - 1) * PRODUCTS_PER_SITEMAP;
  try {
    const rows = await env.DB.prepare(
      `SELECT b.id, b.subdomain, b.updated_at AS b_updated,
              COALESCE(MAX(p.updated_at), 0) AS max_p_updated
       FROM businesses b
       JOIN products p ON p.business_id = b.id AND p.status = 'active'
       WHERE b.approval_status = 'approved'
       GROUP BY b.id, b.subdomain, b.updated_at
       ORDER BY b.id ASC
       LIMIT ? OFFSET ?`
    ).bind(PRODUCTS_PER_SITEMAP, offset).all();

    const entries = (rows.results || []).map((r) => {
      const ts = Math.max(Number(r.b_updated || 0), Number(r.max_p_updated || 0));
      const lastmod = lastmodDate(ts);
      const loc = `${env.SITE_ORIGIN}/s/${String(r.subdomain).toLowerCase()}`;
      return `<url><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
    });

    return xmlResponse(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>`
    );
  } catch (err) {
    console.error("sitemap_stores_error", err?.message);
    return sitemapError();
  }
}

async function handleSitemapProducts(env, page) {
  if (!Number.isInteger(page) || page < 1) return serve404(env);
  const offset = (page - 1) * PRODUCTS_PER_SITEMAP;
  try {
    const rows = await env.DB.prepare(
      `SELECT p.id, p.name, p.updated_at
       FROM products p
       JOIN businesses b ON b.id = p.business_id
       WHERE p.status = 'active' AND b.approval_status = 'approved'
       ORDER BY p.id ASC
       LIMIT ? OFFSET ?`
    ).bind(PRODUCTS_PER_SITEMAP, offset).all();

    const entries = (rows.results || []).map((r) => {
      const loc = `${env.SITE_ORIGIN}/p/${r.id}-${slugify(r.name)}`;
      const lastmod = lastmodDate(r.updated_at);
      return `<url><loc>${escapeXml(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
    });

    return xmlResponse(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>`
    );
  } catch (err) {
    console.error("sitemap_products_error", err?.message);
    return sitemapError();
  }
}

/* ------------------------------------------------------------------ */
/* Product page                                                       */
/* ------------------------------------------------------------------ */

async function handleProduct(request, env, ctx, rawSeg, url) {
  const dashIdx = rawSeg.indexOf("-");
  const productId = dashIdx === -1 ? rawSeg : rawSeg.slice(0, dashIdx);

  if (!PRODUCT_ID_RE.test(productId)) return serve404(env);

  let product;
  try {
    product = await env.DB.prepare(
      `SELECT p.id, p.name, p.description, p.price_ugx, p.offer_price_ugx,
              p.offer_starts_at, p.offer_ends_at, p.image_ids, p.delivery_text,
              p.status, p.updated_at,
              b.name AS b_name, b.subdomain, b.approval_status
       FROM products p
       JOIN businesses b ON b.id = p.business_id
       WHERE p.id = ? LIMIT 1`
    ).bind(productId).first();
  } catch (err) {
    console.error("product_d1_error", err?.message);
    return failOpenProduct(env);
  }

  if (!product || product.status !== "active" || product.approval_status !== "approved") {
    return serve404(env);
  }

  const canonicalPath = `/p/${product.id}-${slugify(product.name)}`;
  if (url.pathname !== canonicalPath) {
    return redirectResponse(env.SITE_ORIGIN + canonicalPath + (url.search || ""));
  }

  /* Cache lookup keyed on canonical URL (no query string). */
  const cacheKey = new Request(env.SITE_ORIGIN + canonicalPath, { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  /* Fetch the static shell. */
  let page;
  try {
    page = await fetch(env.SITE_ORIGIN + "/", { redirect: "follow" });
    if (!page.ok) throw new Error("shell_" + page.status);
  } catch (err) {
    console.error("product_shell_error", err?.message);
    return failOpenProduct(env);
  }

  const now = Math.floor(Date.now() / 1000);
  const { price, offerActive, offerEndsAt } = effectivePrice(product, now);
  const imageIds = parseImageIds(product.image_ids);
  const ogImage = imageIds.length > 0
    ? cloudinaryUrl(imageIds[0], env, { w: 1200, h: 630 })
    : env.DEFAULT_OG_IMAGE;

  const seo = buildProductSeo({ product, price, offerActive, offerEndsAt, imageIds, ogImage, env });

  const rewriter = new HTMLRewriter();
  attachCommonRemovers(rewriter);
  attachHeadAppend(rewriter, seo.headHtml);
  attachBodyPrepend(rewriter, seo.bodyHtml);

  const html = await rewriter.transform(page).text();
  const response = htmlResponse(html);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/* ------------------------------------------------------------------ */
/* Store page                                                         */
/* ------------------------------------------------------------------ */

async function handleStore(request, env, ctx, rawSeg, url) {
  let seg = rawSeg || "";
  let hadTrailingSlash = false;
  if (seg.endsWith("/")) {
    seg = seg.replace(/\/+$/, "");
    hadTrailingSlash = true;
  }
  if (!SUBDOMAIN_RE.test(seg)) return serve404(env);

  if (hadTrailingSlash || seg !== seg.toLowerCase()) {
    return redirectResponse(env.SITE_ORIGIN + "/s/" + seg.toLowerCase() + (url.search || ""));
  }

  /* Cache lookup first (URL-independent of DB data). */
  const canonicalPath = `/s/${seg}`;
  const cacheKey = new Request(env.SITE_ORIGIN + canonicalPath, { method: "GET" });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let business;
  let products;
  try {
    business = await env.DB.prepare(
      `SELECT id, name, subdomain, description, logo_public_id, banner_public_id,
              delivery_text, approval_status, updated_at
       FROM businesses
       WHERE subdomain = ? COLLATE NOCASE AND approval_status = 'approved'
       LIMIT 1`
    ).bind(seg).first();

    if (!business) return serve404(env);

    const rows = await env.DB.prepare(
      `SELECT id, name, price_ugx, offer_price_ugx, offer_starts_at, offer_ends_at
       FROM products
       WHERE business_id = ? AND status = 'active'
       ORDER BY created_at DESC
       LIMIT 20`
    ).bind(business.id).all();
    products = rows.results || [];
  } catch (err) {
    console.error("store_d1_error", err?.message);
    return failOpenStore(env);
  }

  /* Fetch static store shell. */
  let page;
  try {
    page = await fetch(env.SITE_ORIGIN + "/store", { redirect: "follow" });
    if (!page.ok) page = await fetch(env.SITE_ORIGIN + "/store.html", { redirect: "follow" });
    if (!page.ok) throw new Error("store_shell_" + page.status);
  } catch (err) {
    console.error("store_shell_error", err?.message);
    return failOpenStore(env);
  }

  const now = Math.floor(Date.now() / 1000);
  const canonicalUrl = env.SITE_ORIGIN + canonicalPath;
  const seo = buildStoreSeo({ business, products, env, now, canonicalUrl });

  const rewriter = new HTMLRewriter();
  attachCommonRemovers(rewriter);
  attachHeadAppend(rewriter, seo.headHtml);
  attachBodyPrepend(rewriter, seo.bodyHtml);

  const html = await rewriter.transform(page).text();
  const response = htmlResponse(html);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

/* ------------------------------------------------------------------ */
/* Router                                                             */
/* ------------------------------------------------------------------ */

async function routeRequest(request, env, ctx, url) {
  const path = url.pathname;

  if (path === "/sitemap.xml") return handleSitemapIndex(env);
  if (path === "/sitemap-pages.xml") return handleSitemapPages(env);

  const sm = path.match(/^\/sitemap-stores-(\d+)\.xml$/);
  if (sm) return handleSitemapStores(env, Number(sm[1]));

  const pm = path.match(/^\/sitemap-products-(\d+)\.xml$/);
  if (pm) return handleSitemapProducts(env, Number(pm[1]));

  const pMatch = path.match(/^\/p\/(.+)$/);
  if (pMatch) return handleProduct(request, env, ctx, pMatch[1], url);

  const sMatch = path.match(/^\/s\/(.*)$/);
  if (sMatch) return handleStore(request, env, ctx, sMatch[1] || "", url);

  return serve404(env);
}

export default {
  async fetch(request, env, ctx) {
    const method = request.method;
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: {
          Allow: "GET, HEAD",
          "Content-Type": "text/plain; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }

    const url = new URL(request.url);
    let response;
    try {
      response = await routeRequest(request, env, ctx, url);
    } catch (err) {
      if (err instanceof HttpError) {
        response = err.status === 404
          ? await serve404(env)
          : new Response(err.code || "Error", {
              status: err.status,
              headers: { "X-Content-Type-Options": "nosniff" },
            });
      } else {
        console.error("unhandled_error", err?.message);
        response = new Response("Internal Server Error", {
          status: 500,
          headers: { "X-Content-Type-Options": "nosniff" },
        });
      }
    }

    if (method === "HEAD") {
      const { status, headers } = response;
      try { await response.body?.cancel(); } catch { /* ignore */ }
      return new Response(null, { status, headers });
    }
    return response;
  },
};
