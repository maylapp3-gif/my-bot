// Minimal Replit object-storage helper for server-side JSON snapshots.
// We don't need the full presigned-URL/Uppy stack from the object-storage
// skill — we only need to put/get/list/delete tiny JSON blobs from the
// private dir. This file is the entire wrapper.

import { Storage } from "@google-cloud/storage";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

const client = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

function getPrivateDir(): string {
  const d = process.env.PRIVATE_OBJECT_DIR;
  if (!d) throw new Error("PRIVATE_OBJECT_DIR not set — object storage not provisioned.");
  return d;
}

// PRIVATE_OBJECT_DIR is shaped like "/<bucketId>/.private" — first path
// segment is the bucket, the rest is a prefix inside the bucket.
function splitDir(): { bucket: string; insidePrefix: string } {
  // Normalise: strip leading + trailing slashes before splitting so we don't
  // produce empty path segments or accidental double slashes downstream.
  const parts = getPrivateDir().replace(/^\/+/, "").replace(/\/+$/, "").split("/");
  const bucket = parts.shift() ?? "";
  return { bucket, insidePrefix: parts.join("/") };
}

function fullObjectName(relPath: string): string {
  const { insidePrefix } = splitDir();
  return insidePrefix ? `${insidePrefix}/${relPath}` : relPath;
}

export async function putJson(relPath: string, data: unknown): Promise<void> {
  const { bucket } = splitDir();
  const f = client.bucket(bucket).file(fullObjectName(relPath));
  await f.save(JSON.stringify(data, null, 2), {
    contentType: "application/json",
    resumable: false,
  });
}

export async function getJson<T>(relPath: string): Promise<T | null> {
  const { bucket } = splitDir();
  const f = client.bucket(bucket).file(fullObjectName(relPath));
  const [exists] = await f.exists();
  if (!exists) return null;
  const [buf] = await f.download();
  return JSON.parse(buf.toString("utf8")) as T;
}

// Returns rel-paths (reusable with putJson/getJson/deleteObject).
export async function listJsonRelPaths(prefix: string): Promise<string[]> {
  const { bucket, insidePrefix } = splitDir();
  const fullPrefix = insidePrefix ? `${insidePrefix}/${prefix}` : prefix;
  const [files] = await client.bucket(bucket).getFiles({ prefix: fullPrefix });
  return files.map((f) => {
    let n = f.name;
    if (insidePrefix && n.startsWith(insidePrefix + "/")) {
      n = n.slice(insidePrefix.length + 1);
    }
    return n;
  });
}

export async function deleteObject(relPath: string): Promise<void> {
  const { bucket } = splitDir();
  await client.bucket(bucket).file(fullObjectName(relPath)).delete({ ignoreNotFound: true });
}
