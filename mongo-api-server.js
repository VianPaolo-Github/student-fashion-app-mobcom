const fs = require("fs");
const http = require("http");
const path = require("path");
const { MongoClient } = require("mongodb");

function stripQuotes(value) {
  if (typeof value !== "string") return value;
  return value.replace(/^['\"]|['\"]$/g, "");
}

function loadEnvFromFile() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 0) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const rawValue = trimmed.slice(eqIndex + 1).trim();
    const value = stripQuotes(rawValue);

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFromFile();

const PORT = Number(process.env.API_PORT || 4000);
const MONGO_URI = stripQuotes(process.env.MONGO_URI || "");
const MONGO_URI_DIRECT = stripQuotes(process.env.MONGO_URI_DIRECT || "");
const MONGO_DB_NAME = stripQuotes(
  process.env.MONGO_DB_NAME ||
    process.env.EXPO_PUBLIC_MONGO_DB_NAME ||
    "student_fashion",
);
const MONGO_COLLECTION_NAME = stripQuotes(
  process.env.MONGO_CLOTHES_COLLECTION ||
    process.env.EXPO_PUBLIC_MONGO_CLOTHES_COLLECTION ||
    "clothes",
);

if (!MONGO_URI) {
  console.error("Missing MONGO_URI in environment.");
  process.exit(1);
}

let mongoClient = null;
let clothesCollection = null;
let activeMongoUri = MONGO_URI_DIRECT || MONGO_URI;
let hasSrvFallbackAttempted = false;

function isSrvDnsError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    message.includes("querySrv") ||
    message.includes("_mongodb._tcp") ||
    message.includes("ENOTFOUND")
  );
}

function maskMongoUri(uri) {
  return uri.replace(/\/\/([^:]+):([^@]+)@/, "//$1:***@");
}

function parseDnsAnswerData(answerData) {
  if (typeof answerData !== "string") return "";
  return answerData.replace(/^"|"$/g, "").trim();
}

async function resolveDnsOverHttps(name, type) {
  const response = await fetch(
    `https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`,
  );

  if (!response.ok) {
    throw new Error(`DNS-over-HTTPS failed for ${name} (${type})`);
  }

  const json = await response.json();
  return json.Answer || [];
}

async function buildDirectMongoUriFromSrv(srvUri) {
  const parsed = new URL(srvUri);
  const clusterHost = parsed.hostname;

  const srvAnswers = await resolveDnsOverHttps(
    `_mongodb._tcp.${clusterHost}`,
    "SRV",
  );

  const srvHosts = srvAnswers
    .map((record) => {
      const parts = parseDnsAnswerData(record.data).split(/\s+/);
      return parts[3] || "";
    })
    .map((host) => host.replace(/\.$/, ""))
    .filter(Boolean);

  if (srvHosts.length === 0) {
    throw new Error("No SRV hosts found for Atlas cluster.");
  }

  const txtAnswers = await resolveDnsOverHttps(clusterHost, "TXT");
  const txtQuery = txtAnswers
    .map((record) => parseDnsAnswerData(record.data))
    .join("&");

  const mergedQuery = new URLSearchParams(txtQuery);
  for (const [key, value] of parsed.searchParams.entries()) {
    mergedQuery.set(key, value);
  }

  if (!mergedQuery.has("tls") && !mergedQuery.has("ssl")) {
    mergedQuery.set("tls", "true");
  }

  const credentials = parsed.username
    ? `${encodeURIComponent(decodeURIComponent(parsed.username))}:${encodeURIComponent(decodeURIComponent(parsed.password || ""))}@`
    : "";

  return `mongodb://${credentials}${srvHosts.join(",")}/?${mergedQuery.toString()}`;
}

async function getClothesCollection() {
  if (clothesCollection) return clothesCollection;

  try {
    mongoClient = new MongoClient(activeMongoUri);
    await mongoClient.connect();
  } catch (error) {
    const canTrySrvFallback =
      !MONGO_URI_DIRECT &&
      !hasSrvFallbackAttempted &&
      MONGO_URI.startsWith("mongodb+srv://") &&
      isSrvDnsError(error);

    if (!canTrySrvFallback) {
      throw error;
    }

    hasSrvFallbackAttempted = true;
    const directUri = await buildDirectMongoUriFromSrv(MONGO_URI);
    activeMongoUri = directUri;

    console.warn(
      "SRV DNS lookup failed locally. Retrying Atlas connection using direct hosts via DNS-over-HTTPS.",
    );
    console.warn(`Using fallback URI: ${maskMongoUri(activeMongoUri)}`);

    mongoClient = new MongoClient(activeMongoUri);
    await mongoClient.connect();
  }

  const db = mongoClient.db(MONGO_DB_NAME);
  clothesCollection = db.collection(MONGO_COLLECTION_NAME);
  await clothesCollection.createIndex({ id: 1 }, { unique: true });

  return clothesCollection;
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function sanitizeItem(input) {
  const category =
    input?.category === "top" ||
    input?.category === "bottom" ||
    input?.category === "shoes"
      ? input.category
      : "top";

  return {
    id: String(input?.id || ""),
    category,
    type: String(input?.type || ""),
    name: String(input?.name || ""),
    color: String(input?.color || ""),
    warmth: String(input?.warmth || ""),
    image: input?.image ?? "",
  };
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.method) {
    sendJson(res, 400, { error: "Invalid request" });
    return;
  }

  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`,
  );
  const pathname = requestUrl.pathname;

  try {
    if (req.method === "GET" && pathname === "/health") {
      await getClothesCollection();
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && pathname === "/api/clothes") {
      const collection = await getClothesCollection();
      const items = await collection
        .find({}, { projection: { _id: 0 } })
        .toArray();
      sendJson(res, 200, { items });
      return;
    }

    if (req.method === "POST" && pathname === "/api/clothes") {
      const collection = await getClothesCollection();
      const body = await parseJsonBody(req);
      const item = sanitizeItem(body);

      if (!item.id) {
        sendJson(res, 400, { error: "Item id is required" });
        return;
      }

      await collection.insertOne(item);
      sendJson(res, 201, { ok: true, item });
      return;
    }

    const itemRouteMatch = pathname.match(/^\/api\/clothes\/([^/]+)$/);
    if (itemRouteMatch && req.method === "PUT") {
      const collection = await getClothesCollection();
      const itemId = decodeURIComponent(itemRouteMatch[1]);
      const body = await parseJsonBody(req);
      const item = sanitizeItem({ ...body, id: itemId });
      const { id: _id, ...fieldsToUpdate } = item;

      const result = await collection.updateOne(
        { id: itemId },
        { $set: fieldsToUpdate },
      );
      if (result.matchedCount === 0) {
        sendJson(res, 404, { error: "Item not found" });
        return;
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    if (itemRouteMatch && req.method === "DELETE") {
      const collection = await getClothesCollection();
      const itemId = decodeURIComponent(itemRouteMatch[1]);
      const result = await collection.deleteOne({ id: itemId });

      if (result.deletedCount === 0) {
        sendJson(res, 404, { error: "Item not found" });
        return;
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "Route not found" });
  } catch (error) {
    if (error && error.code === 11000) {
      sendJson(res, 409, { error: "Duplicate item id" });
      return;
    }

    const message =
      error instanceof Error ? error.message : "Internal server error";
    sendJson(res, 500, { error: message });
  }
});

server.listen(PORT, () => {
  console.log(`Mongo API server running at http://localhost:${PORT}`);
  console.log(
    `Connected collection: ${MONGO_DB_NAME}.${MONGO_COLLECTION_NAME}`,
  );
});

process.on("SIGINT", async () => {
  if (mongoClient) {
    await mongoClient.close();
  }
  process.exit(0);
});
