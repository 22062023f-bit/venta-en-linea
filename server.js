const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const fetch = require("node-fetch");
const cheerio = require("cheerio");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PROOF_BYTES = 5 * 1024 * 1024;
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const allowedDomains = [
  "temu.com",
  "amazon.com",
  "amazon.com.mx",
  "amazon.es",
  "aliexpress.com",
  "aliexpress.us",
  "shein.com",
  "shein.com.mx",
  "tiktok.com"
];

function isAllowedProductUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      allowedDomains.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
      ? url
      : null;
  } catch {
    return null;
  }
}

function normalizePrice(value) {
  if (value == null) return null;
  const cleaned = String(value).trim().replace(/[^\d.,]/g, "");
  if (!cleaned) return null;
  const decimalSeparator = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf(","));
  const normalized = decimalSeparator >= 0
    ? `${cleaned.slice(0, decimalSeparator).replace(/[.,]/g, "")}.${cleaned.slice(decimalSeparator + 1).replace(/[.,]/g, "")}`
    : cleaned;
  const price = Number(normalized);
  return Number.isFinite(price) && price > 0 && price <= 1000000 ? price : null;
}

function findProductPrice(value) {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const price = findProductPrice(entry);
      if (price != null) return price;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const type = value["@type"];
  const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
  if (isProduct) {
    const offers = Array.isArray(value.offers) ? value.offers : [value.offers];
    for (const offer of offers) {
      const price = normalizePrice(offer && (offer.price ?? offer.lowPrice));
      if (price != null) return price;
    }
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const price = findProductPrice(child);
      if (price != null) return price;
    }
  }
  return null;
}

async function readLimitedBody(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > MAX_PAGE_BYTES) {
      response.body.destroy();
      throw new Error("La página del producto es demasiado grande.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const acceptedFiles = {
  "image/jpeg": { extension: ".jpg", signature: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  "image/png": { extension: ".png", signature: bytes => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/webp": { extension: ".webp", signature: bytes => bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" },
  "application/pdf": { extension: ".pdf", signature: bytes => bytes.toString("ascii", 0, 5) === "%PDF-" }
};

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, callback) => {
      callback(null, `${crypto.randomUUID()}${acceptedFiles[file.mimetype].extension}`);
    }
  }),
  limits: { fileSize: MAX_PROOF_BYTES, files: 1 },
  fileFilter: (req, file, callback) => {
    if (!acceptedFiles[file.mimetype]) return callback(new Error("Solo se aceptan archivos JPG, PNG, WebP o PDF."));
    callback(null, true);
  }
});

app.disable("x-powered-by");
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/index.html", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.get("/fetch", async (req, res) => {
  const url = isAllowedProductUrl(req.query.url);
  if (!url) {
    return res.status(400).json({ error: "Pega un enlace HTTPS de Temu, Amazon, AliExpress, Shein o TikTok Shop." });
  }

  try {
    const response = await fetch(url.href, {
      redirect: "manual",
      timeout: 8000,
      size: MAX_PAGE_BYTES,
      headers: { "User-Agent": "BarriosProductInfo/1.0" }
    });
    if (response.status >= 300 && response.status < 400) {
      return res.status(422).json({ error: "La tienda redirige este enlace. Pega el enlace final del producto." });
    }
    if (!response.ok) return res.status(502).json({ error: "La tienda no permitió consultar este producto." });
    if (!String(response.headers.get("content-type") || "").includes("text/html")) {
      return res.status(415).json({ error: "El enlace no apunta a una página de producto legible." });
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_PAGE_BYTES) {
      return res.status(413).json({ error: "La página del producto es demasiado grande." });
    }

    const $ = cheerio.load(await readLimitedBody(response));
    const title = String(
      $('meta[property="og:title"]').attr("content") ||
      $('meta[name="twitter:title"]').attr("content") ||
      $("title").text() ||
      ""
    ).trim().slice(0, 180);
    let price = normalizePrice(
      $('meta[property="product:price:amount"]').attr("content") ||
      $('meta[property="og:price:amount"]').attr("content") ||
      $('meta[itemprop="price"]').attr("content") ||
      $('meta[name="price"]').attr("content")
    );

    if (price == null) {
      for (const script of $('script[type="application/ld+json"]').toArray()) {
        try {
          price = findProductPrice(JSON.parse($(script).text()));
          if (price != null) break;
        } catch {
          // Ignore malformed structured data and continue checking other product metadata.
        }
      }
    }

    res.json({ title, price });
  } catch (error) {
    console.error("No se pudo leer el enlace del producto:", error.message || error);
    res.status(502).json({ error: "No se pudo leer el producto; completa el nombre y precio manualmente." });
  }
});

app.post("/upload-proof", (req, res) => {
  upload.single("proof")(req, res, async error => {
    if (error) {
      const status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).json({ error: error.message || "No se pudo recibir el archivo." });
    }
    if (!req.file) return res.status(400).json({ error: "Selecciona un comprobante para subir." });

    try {
      const bytes = await fs.promises.readFile(req.file.path);
      const format = acceptedFiles[req.file.mimetype];
      if (!format || !format.signature(bytes.subarray(0, 12))) {
        await fs.promises.unlink(req.file.path);
        return res.status(415).json({ error: "El contenido no coincide con el tipo de archivo seleccionado." });
      }
      res.status(201).json({
        url: `/uploads/${encodeURIComponent(req.file.filename)}`,
        filename: req.file.filename
      });
    } catch (uploadError) {
      console.error("No se pudo guardar el comprobante:", uploadError);
      res.status(500).json({ error: "No se pudo guardar el comprobante." });
    }
  });
});

app.get("/uploads/:filename", (req, res) => {
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp|pdf)$/.test(req.params.filename)) {
    return res.sendStatus(404);
  }
  res.set("Cache-Control", "private, no-store");
  res.set("X-Content-Type-Options", "nosniff");
  res.sendFile(path.join(uploadDir, req.params.filename), error => {
    if (error && !res.headersSent) res.sendStatus(error.statusCode === 404 ? 404 : 500);
  });
});

app.listen(PORT, () => {
  console.log(`Barrios está disponible en http://localhost:${PORT}`);
});
