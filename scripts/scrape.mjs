// Recipe scraper — runs in GitHub Actions on a schedule.
// Writes ../data/recipes.json relative to this file.
// Node 20+ (built-in fetch). Only external dep: cheerio.

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "..", "data", "recipes.json");

// Look like a real Chrome — some sites 403 generic bots.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const PER_SOURCE_CAP = 25;
const FETCH_TIMEOUT_MS = 25_000;
const MAX_CANDIDATES_MULTIPLIER = 4; // fetch up to cap*4 pages, drop garbage post-hoc

const MUSHROOM_TERMS = ["champignon","paddenstoel","mushroom","shiitake","oesterzwam","portobello","kastanjechampignon"];

async function fetchText(url) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "nl-BE,nl;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
      },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!r.ok) return null;
    return await r.text();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(to);
  }
}

function flattenLd(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach(n => flattenLd(n, out)); return; }
  out.push(node);
  if (node["@graph"]) flattenLd(node["@graph"], out);
  if (node.itemListElement) flattenLd(node.itemListElement, out);
  if (node.item && typeof node.item === "object") flattenLd(node.item, out);
}

function extractJsonLd(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const txt = $(el).contents().text().trim();
      if (!txt) return;
      flattenLd(JSON.parse(txt), out);
    } catch (_) {}
  });
  return out;
}

function isRecipeNode(node) {
  if (!node || typeof node !== "object") return false;
  const t = node["@type"];
  return t === "Recipe" || (Array.isArray(t) && t.includes("Recipe"));
}

function findRecipeNodes(jsonld) {
  return jsonld.filter(isRecipeNode);
}

function extractOg($) {
  const pick = (sel) => {
    const v = $(sel).attr("content");
    return v ? v.trim() : null;
  };
  return {
    title: pick('meta[property="og:title"]') || pick('meta[name="twitter:title"]') || $("title").text().trim() || null,
    image: pick('meta[property="og:image"]') || pick('meta[property="og:image:secure_url"]') || pick('meta[name="twitter:image"]') || pick('meta[name="twitter:image:src"]'),
    description: pick('meta[property="og:description"]') || pick('meta[name="description"]') || pick('meta[name="twitter:description"]'),
    canonical: $('link[rel="canonical"]').attr("href") || pick('meta[property="og:url"]') || null,
  };
}

function parseISO8601Duration(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/);
  if (!m) return null;
  const h = parseInt(m[1] || "0", 10);
  const min = parseInt(m[2] || "0", 10);
  const total = h * 60 + min;
  return total > 0 ? total : null;
}

function normIngredients(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(s => {
    if (typeof s !== "string") return null;
    const t = s.trim();
    if (!t) return null;
    const m = t.match(/^([\d.,/¼½¾⅓⅔⅛⅜⅝⅞]+\s?(?:g|gram|kg|ml|l|el|tl|tsp|tbsp|cup|stuks?|stuk|takjes?|takje|teen|tenen|blik|blikjes?|pak|pakjes?|snuf(?:je)?|hand|handje)?\s+)(.+)$/i);
    if (m) return { name: m[2].toLowerCase().trim(), quantity: m[1].trim() };
    return { name: t.toLowerCase(), quantity: "" };
  }).filter(Boolean);
}

function detectDietary(node, name, ingredientsLc, tags) {
  const out = new Set();
  const text = (name + " " + tags.join(" ") + " " + ingredientsLc.join(" ")).toLowerCase();
  const cat = (Array.isArray(node.recipeCategory) ? node.recipeCategory : [node.recipeCategory]).filter(Boolean).map(s=>String(s).toLowerCase()).join(" ");
  const all = text + " " + cat;
  if (/vegetari/.test(all) || /\bveggie\b/.test(all)) out.add("vegetarian");
  if (/\bvegan\b/.test(all) || /plantaardig/.test(all)) out.add("vegan");
  if (/pescatari|vis-?vriendelijk/.test(all)) out.add("pescatarian");
  if (/glutenvrij|gluten[- ]?free|zonder gluten/.test(all)) out.add("gluten-free");
  if (/lactosevrij|lactose[- ]?free|zonder lactose/.test(all)) out.add("lactose-free");
  if (/kindvriendel|family[- ]?friendly|family friendly|kinderen/.test(all)) out.add("family-friendly");
  return [...out];
}

function detectCuisine(name, tags) {
  const t = (name + " " + tags.join(" ")).toLowerCase();
  const map = [
    ["Italian", /\b(pasta|spaghetti|lasagne|pizza|risotto|gnocchi|pesto|parmezaan|italian|italiaans)\b/],
    ["Asian", /\b(asia|aziatisch|wok|curry|thai|indian|indiaas|chinees|japans|korean|vietnam|teriyaki|sushi|noedel|noodle|udon|ramen|pad thai|satay|saté)\b/],
    ["Mexican", /\b(taco|burrito|fajita|quesadilla|enchilada|mexican|mexicaans|wraps?|nacho)\b/],
    ["Middle Eastern", /\b(falafel|shawarma|hummus|tagine|tajine|kebab|baba|harissa)\b/],
    ["French", /\b(quiche|coq au vin|bourguignon|ratatouille|gratin|provence)\b/],
    ["Belgian/Dutch", /\b(stoof|stoofvlees|stamppot|witloof|waterzooi|hutspot|boerenkost|carbonade|frietjes|patatten|hollandse)\b/],
    ["American", /\b(burger|bbq|barbecue|cheddar|buffalo)\b/],
    ["Mediterranean", /\b(grieks|greek|tzatziki|spanjaards|spaans|spanish|paella|chorizo)\b/],
  ];
  for (const [label, re] of map) if (re.test(t)) return label;
  return null;
}

function detectContains(ingredientsLc) {
  const contains = new Set();
  const joined = ingredientsLc.join(" ");
  if (MUSHROOM_TERMS.some(t => joined.includes(t))) contains.add("mushroom");
  if (/\b(kip|chicken)\b/.test(joined)) contains.add("chicken");
  if (/\b(rund|beef|gehakt|biefstuk)\b/.test(joined)) contains.add("beef");
  if (/\b(varken|pork|spek|ham|bacon)\b/.test(joined)) contains.add("pork");
  if (/\b(zalm|salmon|tonijn|tuna|kabeljauw|cod|vis\b|fish)\b/.test(joined)) contains.add("fish");
  if (/\b(garnaal|shrimp|prawn|scampi|mossel|shellfish|schaaldier)\b/.test(joined)) contains.add("shellfish");
  if (/\b(noten|noot|amandel|hazelnoot|walnoot|nuts?)\b/.test(joined)) contains.add("nuts");
  if (/\b(pinda|peanut)\b/.test(joined)) contains.add("peanut");
  if (/\b(ei|eieren|eggs?)\b/.test(joined)) contains.add("egg");
  if (/\b(kaas|cheese|mozzarella|cheddar|parmezaan|feta)\b/.test(joined)) contains.add("dairy");
  if (/\b(tofu|tempeh|seitan)\b/.test(joined)) contains.add("plant-protein");
  return [...contains];
}

function pickImage(node, og) {
  if (typeof node.image === "string") return node.image;
  if (Array.isArray(node.image)) {
    const first = node.image[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && first.url) return first.url;
  }
  if (node.image && typeof node.image === "object" && node.image.url) return node.image.url;
  if (og && og.image) return og.image;
  return null;
}

function pickDescription(node, og) {
  if (typeof node.description === "string" && node.description.trim()) return node.description.trim().slice(0, 240);
  if (og && og.description) return og.description.slice(0, 240);
  return "";
}

function recipeFromJsonLd(node, og, sourceLabel, fallbackUrl, sourceId, idx) {
  if (!node) return null;

  let name = "";
  if (typeof node.name === "string") name = node.name.trim();
  else if (Array.isArray(node.name) && typeof node.name[0] === "string") name = node.name[0].trim();
  if (!name && og && og.title) name = og.title.trim();
  if (!name) return null;

  let url = fallbackUrl;
  if (typeof node.mainEntityOfPage === "string") url = node.mainEntityOfPage;
  else if (node.mainEntityOfPage && typeof node.mainEntityOfPage === "object" && node.mainEntityOfPage["@id"]) url = node.mainEntityOfPage["@id"];
  else if (typeof node.url === "string") url = node.url;
  else if (og && og.canonical) url = og.canonical;

  const cookMin = parseISO8601Duration(node.totalTime) ?? parseISO8601Duration(node.cookTime) ?? parseISO8601Duration(node.prepTime);
  const ing = normIngredients(node.recipeIngredient || node.ingredients || []);
  const ingredientsLc = ing.map(i => i.name);
  const tags = []
    .concat(Array.isArray(node.keywords) ? node.keywords : (typeof node.keywords === "string" ? node.keywords.split(",") : []))
    .concat(Array.isArray(node.recipeCategory) ? node.recipeCategory : (node.recipeCategory ? [node.recipeCategory] : []))
    .concat(Array.isArray(node.recipeCuisine) ? node.recipeCuisine : (node.recipeCuisine ? [node.recipeCuisine] : []))
    .map(s => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);

  const image = pickImage(node, og);
  const description = pickDescription(node, og);

  const yield_ = node.recipeYield || node.yield;
  let servings = null;
  if (typeof yield_ === "number") servings = yield_;
  else if (typeof yield_ === "string") {
    const m = yield_.match(/\d+/);
    if (m) servings = parseInt(m[0], 10);
  }

  return {
    id: `${sourceId}-${String(idx).padStart(3,"0")}`,
    source: sourceLabel,
    name,
    url,
    image,
    cook_time_min: cookMin,
    servings,
    tags,
    dietary: detectDietary(node, name, ingredientsLc, tags),
    cuisine: detectCuisine(name, tags),
    contains: detectContains(ingredientsLc),
    ingredients: ing,
    description,
  };
}

async function discoverUrls(html, baseUrl, urlFilter, max) {
  const out = new Set();
  if (!html) return [...out];
  // sitemap.xml-style entries
  const locMatches = html.match(/<loc>([^<]+)<\/loc>/gi) || [];
  for (const m of locMatches) {
    const u = m.replace(/<\/?loc>/gi, "").trim();
    if (urlFilter(u)) out.add(u);
    if (out.size >= max) break;
  }
  // nested sitemap indexes: if the sitemap only contained sub-sitemap URLs,
  // recurse one level so we can still discover recipe URLs.
  if (out.size === 0) {
    const subSitemaps = locMatches
      .map(m => m.replace(/<\/?loc>/gi, "").trim())
      .filter(u => /sitemap.*\.xml/i.test(u))
      .slice(0, 8);
    for (const sm of subSitemaps) {
      if (out.size >= max) break;
      const subXml = await fetchText(sm);
      if (!subXml) continue;
      const subLocs = subXml.match(/<loc>([^<]+)<\/loc>/gi) || [];
      for (const m of subLocs) {
        const u = m.replace(/<\/?loc>/gi, "").trim();
        if (urlFilter(u)) out.add(u);
        if (out.size >= max) break;
      }
    }
  }
  if (out.size < max) {
    const $ = cheerio.load(html);
    $("a[href]").each((_, el) => {
      let href = $(el).attr("href"); if (!href) return;
      try {
        if (href.startsWith("/")) href = new URL(href, baseUrl).toString();
        if (!href.startsWith("http")) return;
        const u = new URL(href);
        u.hash = ""; u.search = "";
        href = u.toString();
      } catch (_) { return; }
      if (urlFilter(href)) out.add(href);
      if (out.size >= max) return false;
    });
  }
  return [...out];
}

function isUseful(r) {
  if (!r || !r.name) return false;
  if (r.image) return true;
  if ((r.ingredients || []).length >= 3) return true;
  if (r.cook_time_min != null && r.description) return true;
  return false;
}

async function scrapeSource({ sourceLabel, sourceId, seedUrls, urlFilter, sitemapUrls = [], cap = PER_SOURCE_CAP }) {
  console.log(`\n=== ${sourceLabel} ===`);
  const urls = new Set();
  const wantedCandidates = cap * MAX_CANDIDATES_MULTIPLIER;

  for (const sm of sitemapUrls) {
    const xml = await fetchText(sm);
    if (!xml) { console.log(`  sitemap ${sm} -> empty`); continue; }
    const discovered = await discoverUrls(xml, sm, urlFilter, wantedCandidates);
    discovered.forEach(u => urls.add(u));
    console.log(`  sitemap ${sm} -> ${discovered.length} candidates`);
    if (urls.size >= wantedCandidates) break;
  }
  if (urls.size < cap) {
    for (const seed of seedUrls) {
      const html = await fetchText(seed);
      if (!html) { console.log(`  seed ${seed} -> empty`); continue; }
      const discovered = await discoverUrls(html, seed, urlFilter, wantedCandidates);
      discovered.forEach(u => urls.add(u));
      console.log(`  seed ${seed} -> ${discovered.length} candidates`);
      if (urls.size >= wantedCandidates) break;
    }
  }

  const recipeUrls = [...urls].slice(0, wantedCandidates);
  console.log(`  Will fetch ${recipeUrls.length} candidate pages`);

  const out = [];
  let idx = 1;
  for (const url of recipeUrls) {
    if (out.length >= cap) break;
    const html = await fetchText(url);
    if (!html) continue;
    const $ = cheerio.load(html);
    const og = extractOg($);
    const ld = extractJsonLd(html);
    const recipeNodes = findRecipeNodes(ld);
    if (!recipeNodes.length) continue;
    for (const node of recipeNodes.slice(0, 1)) {
      const built = recipeFromJsonLd(node, og, sourceLabel, url, sourceId, idx);
      if (!built) continue;
      if (!isUseful(built)) continue;
      out.push(built);
      idx++;
      if (out.length >= cap) break;
    }
  }
  console.log(`  -> ${out.length} recipes kept`);
  return out;
}

// URL patterns verified against actual recipe pages (recipe-scrapers v15.11.0
// supported-sites registry + cached page bodies, May 2026).
// HelloFresh / Foodbag / Foodprepper dropped — see report.
const SOURCES = [
  {
    // /gerechten/<slug>  e.g. /gerechten/vol-au-vent
    sourceLabel: "Dagelijkse Kost",
    sourceId: "dk",
    sitemapUrls: [
      "https://dagelijksekost.vrt.be/sitemap.xml",
      "https://dagelijksekost.vrt.be/sitemap_index.xml",
    ],
    seedUrls: [
      "https://dagelijksekost.vrt.be/gerechten",
      "https://dagelijksekost.vrt.be/",
    ],
    urlFilter: u => /^https?:\/\/(www\.)?dagelijksekost\.vrt\.be\/gerechten\/[^/?#]+/i.test(u),
  },
  {
    // /allerhande/recept/R-R<id>/<slug>
    sourceLabel: "AH Allerhande",
    sourceId: "ah",
    sitemapUrls: [
      "https://www.ah.nl/sitemaps/entities/recipes/detail.xml",
      "https://www.ah.nl/allerhande/sitemap.xml",
    ],
    seedUrls: [
      "https://www.ah.nl/allerhande/recepten-zoeken",
      "https://www.ah.nl/allerhande/recepten/snelle-recepten",
      "https://www.ah.nl/allerhande/recepten/pasta",
    ],
    urlFilter: u => /^https?:\/\/(www\.)?ah\.nl\/allerhande\/recept\/R[-_]?R?\d+/i.test(u),
  },
  {
    // /bekijk-recept/<id>/<slug>  e.g. /bekijk-recept/11733/klassieke-quiche-lorraine-1
    sourceLabel: "Libelle Lekker",
    sourceId: "lib",
    sitemapUrls: [
      "https://www.libelle-lekker.be/sitemap.xml",
      "https://www.libelle-lekker.be/sitemap_index.xml",
    ],
    seedUrls: [
      "https://www.libelle-lekker.be/koken/recepten",
      "https://www.libelle-lekker.be/",
    ],
    urlFilter: u => /^https?:\/\/(www\.)?libelle-lekker\.be\/bekijk-recept\/\d+\/[^/?#]+/i.test(u),
  },
  {
    // /menu/<id>-<slug>  (per-recipe detail under the menu namespace)
    sourceLabel: "Marley Spoon BE",
    sourceId: "ms",
    sitemapUrls: [
      "https://marleyspoon.be/sitemap.xml",
      "https://marleyspoon.be/sitemap_index.xml",
    ],
    seedUrls: [
      "https://marleyspoon.be/menu",
      "https://marleyspoon.be/",
    ],
    urlFilter: u => /^https?:\/\/(www\.)?marleyspoon\.be\/menu\/\d+[-/][^/?#]+/i.test(u),
  },
  {
    // /recepten/<slug>
    sourceLabel: "24Kitchen",
    sourceId: "tfk",
    sitemapUrls: [
      "https://www.24kitchen.nl/sitemap.xml",
      "https://www.24kitchen.nl/sitemap_index.xml",
      "https://www.24kitchen.nl/sitemap-recipes.xml",
    ],
    seedUrls: [
      "https://www.24kitchen.nl/recepten",
      "https://www.24kitchen.nl/",
    ],
    urlFilter: u => /^https?:\/\/(www\.)?24kitchen\.nl\/recepten\/[^/?#]+/i.test(u),
  },
  {
    // /recept/<slug>
    sourceLabel: "15gram",
    sourceId: "fg",
    sitemapUrls: [
      "https://15gram.be/sitemap.xml",
      "https://15gram.be/sitemap_index.xml",
      "https://www.15gram.be/sitemap.xml",
    ],
    seedUrls: [
      "https://15gram.be/recepten",
      "https://15gram.be/",
    ],
    urlFilter: u => /^https?:\/\/(www\.)?15gram\.be\/recept\/[^/?#]+/i.test(u),
  },
  {
    // /recepten/<slug>
    sourceLabel: "Leuke Recepten",
    sourceId: "lr",
    sitemapUrls: [
      "https://www.leukerecepten.nl/sitemap_index.xml",
      "https://www.leukerecepten.nl/sitemap.xml",
      "https://www.leukerecepten.nl/post-sitemap.xml",
    ],
    seedUrls: [
      "https://www.leukerecepten.nl/recepten/",
      "https://www.leukerecepten.nl/",
    ],
    urlFilter: u => /^https?:\/\/(www\.)?leukerecepten\.nl\/recepten\/[^/?#]+/i.test(u),
  },
];

function loadExisting() {
  if (!existsSync(OUT)) return null;
  try {
    const txt = readFileSync(OUT, "utf8");
    const d = JSON.parse(txt);
    if (d && Array.isArray(d.recipes) && d.recipes.length) return d;
  } catch (_) {}
  return null;
}

async function main() {
  const allRecipes = [];
  for (const s of SOURCES) {
    try {
      const recs = await scrapeSource(s);
      allRecipes.push(...recs);
    } catch (e) {
      console.error(`Source ${s.sourceLabel} failed:`, e.message);
    }
  }

  console.log(`\nTotal recipes: ${allRecipes.length}`);
  const withImage = allRecipes.filter(r => r.image).length;
  const withIngredients = allRecipes.filter(r => (r.ingredients||[]).length).length;
  console.log(`  with image: ${withImage} | with ingredients: ${withIngredients}`);

  // Safety net: if a run returns nothing, keep whatever we had before.
  if (allRecipes.length === 0) {
    const prior = loadExisting();
    if (prior) {
      console.log("Scrape returned 0 recipes — keeping prior data/recipes.json intact.");
      return;
    }
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    generated_at: new Date().toISOString().slice(0, 10),
    recipes: allRecipes,
  }, null, 2));
  console.log(`Wrote ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
