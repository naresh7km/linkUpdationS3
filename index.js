require("dotenv").config();
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { createClient } = require("redis");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const {
  S3ControlClient,
  CreateAccessPointCommand,
  DeleteAccessPointCommand,
  ListAccessPointsCommand,
} = require("@aws-sdk/client-s3-control");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const app = express();
const port = process.env.PORT || 3000;

// CONFIGURATION
const REGION = process.env.AWS_REGION || "ap-northeast-1";
const ACCOUNT_ID = "654654618464";
const BUCKET_NAME = process.env.BUCKET_NAME;

// Redis keys — shared contract with the consumer server
const KEY_UNUSED = "aps:unused"; // List of unused AP names
const KEY_USED = "aps:used"; // Set of AP names already served
const KEY_CURRENT_AP = "current:ap"; // Name of the currently served AP
const KEY_CURRENT_URL = "current:url"; // Presigned URL the consumer reads

const s3Client = new S3Client({ region: REGION });
const s3Control = new S3ControlClient({ region: REGION });

const redis = createClient({ url: process.env.REDIS_URL });
redis.on("error", (err) => console.error("Redis error:", err));

let statusMessage = "";

// --- CORE AWS LOGIC ---

async function resetAndCreateNewBatch() {
  statusMessage = "Step 1: Cleaning up old Access Points...";

  try {
    const listData = await s3Control.send(
      new ListAccessPointsCommand({
        AccountId: ACCOUNT_ID,
        Bucket: BUCKET_NAME,
      }),
    );

    const existingAPs = listData.AccessPointList || [];

    for (const ap of existingAPs) {
      console.log(`Deleting old AP: ${ap.Name}`);
      await s3Control.send(
        new DeleteAccessPointCommand({
          AccountId: ACCOUNT_ID,
          Name: ap.Name,
        }),
      );
    }

    statusMessage = `Step 2: Creating 20 fresh Access Points...`;
    const newAPs = [];

    for (let i = 1; i <= 20; i++) {
      const name = `ap-${uuidv4().split("-")[0]}-${i}`;
      await s3Control.send(
        new CreateAccessPointCommand({
          AccountId: ACCOUNT_ID,
          Name: name,
          Bucket: BUCKET_NAME,
        }),
      );
      newAPs.push(name);
      console.log(`Created new AP: ${name}`);
    }

    await redis
      .multi()
      .del(KEY_UNUSED)
      .del(KEY_USED)
      .del(KEY_CURRENT_AP)
      .del(KEY_CURRENT_URL)
      .rPush(KEY_UNUSED, newAPs)
      .exec();

    statusMessage = "Success! Old APs cleared and 20 fresh ones created.";
  } catch (err) {
    console.error("Batch Error:", err);
    statusMessage = "Error during reset: " + err.message;
  }
}

async function seedFromExistingAPs() {
  statusMessage = "Seeding Redis from existing AWS Access Points...";

  try {
    const listData = await s3Control.send(
      new ListAccessPointsCommand({
        AccountId: ACCOUNT_ID,
        Bucket: BUCKET_NAME,
      }),
    );

    const existingAPs = (listData.AccessPointList || []).map((ap) => ap.Name);

    if (existingAPs.length === 0) {
      statusMessage = "No existing Access Points found to seed.";
      return;
    }

    await redis
      .multi()
      .del(KEY_UNUSED)
      .del(KEY_USED)
      .del(KEY_CURRENT_AP)
      .del(KEY_CURRENT_URL)
      .rPush(KEY_UNUSED, existingAPs)
      .exec();

    statusMessage = `Seeded ${existingAPs.length} existing AP(s) into Redis.`;
  } catch (err) {
    console.error("Seed Error:", err);
    statusMessage = "Error during seed: " + err.message;
  }
}

async function generatePresignedUrl(apName) {
  const apArn = `arn:aws:s3:${REGION}:${ACCOUNT_ID}:accesspoint/${apName}`;
  const command = new GetObjectCommand({
    Bucket: apArn,
    Key: "index.html",
  });
  return await getSignedUrl(s3Client, command, { expiresIn: 3600 });
}

// --- ROUTES ---

app.get("/", async (req, res) => {
  const [queueLength, nextAP, currentUrl] = await Promise.all([
    redis.lLen(KEY_UNUSED),
    redis.lIndex(KEY_UNUSED, 0),
    redis.get(KEY_CURRENT_URL),
  ]);

  const html = `
    <html>
        <head>
            <title>S3 AP Manager</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px; background: #f0f2f5; color: #1c1e21; }
                .container { max-width: 700px; margin: auto; background: white; padding: 30px; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.1); }
                h1 { margin-top: 0; color: #007bff; border-bottom: 2px solid #f0f2f5; padding-bottom: 15px; }
                .status-banner { padding: 12px; background: #e7f3ff; border-left: 5px solid #007bff; margin-bottom: 20px; font-weight: 500; }
                .url-display { background: #282c34; color: #61dafb; padding: 20px; border-radius: 8px; word-break: break-all; font-family: 'Courier New', monospace; font-size: 0.85em; margin: 20px 0; min-height: 40px; border: 1px solid #444; }
                .actions { display: flex; gap: 15px; }
                button { padding: 15px 25px; border: none; border-radius: 8px; font-size: 1em; font-weight: bold; cursor: pointer; transition: transform 0.1s; }
                button:active { transform: scale(0.98); }
                .btn-next { background: #28a745; color: white; flex: 2; }
                .btn-seed { background: #6c757d; color: white; flex: 1; }
                .btn-create { background: #dc3545; color: white; flex: 1; }
                .info { margin-top: 30px; font-size: 0.9em; color: #606770; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>S3 AP Dashboard</h1>

                ${statusMessage ? `<div class="status-banner">${statusMessage}</div>` : ""}

                <div class="url-display">${currentUrl || "No URL currently active"}</div>

                <div class="actions">
                    <form action="/next-user" method="POST" style="flex: 2">
                        <button type="submit" class="btn-next">Serve Next URL</button>
                    </form>

                    <form action="/seed-existing" method="POST" style="flex: 1">
                        <button type="submit" class="btn-seed" onclick="return confirm('Load existing AWS Access Points into Redis? This overwrites the current queue.')">Seed From AWS</button>
                    </form>

                    <form action="/create-fresh" method="POST" style="flex: 1">
                        <button type="submit" class="btn-create" onclick="return confirm('Wipe all existing APs and create 20 new ones?')">Create Fresh APs</button>
                    </form>
                </div>

                <div class="info">
                    <p><strong>Queue:</strong> ${queueLength} Access Points ready</p>
                    <p><strong>Next AP in line:</strong> ${nextAP || "Empty"}</p>
                </div>
            </div>
        </body>
    </html>
    `;
  res.send(html);
});

app.post("/next-user", async (req, res) => {
  const nextAP = await redis.lPop(KEY_UNUSED);

  if (nextAP) {
    const url = await generatePresignedUrl(nextAP);
    await redis
      .multi()
      .sAdd(KEY_USED, nextAP)
      .set(KEY_CURRENT_AP, nextAP)
      .set(KEY_CURRENT_URL, url)
      .exec();
    statusMessage = `Switched to AP: ${nextAP}`;
  } else {
    await redis.set(KEY_CURRENT_URL, "QUEUE EMPTY");
    statusMessage = "All 20 APs used. Please click 'Create Fresh APs'.";
  }
  res.redirect("/");
});

app.post("/seed-existing", async (req, res) => {
  await seedFromExistingAPs();
  res.redirect("/");
});

app.post("/create-fresh", async (req, res) => {
  await resetAndCreateNewBatch();
  res.redirect("/");
});

(async () => {
  await redis.connect();
  app.listen(port, () => {
    console.log(`Dashboard active: http://localhost:${port}`);
  });
})();
