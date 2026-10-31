import { readdir, readFile } from "node:fs/promises";
import { database } from "./db/client.ts";

const directory = new URL("./migrations/", import.meta.url);
const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
for (const file of files) {
  const sql = await readFile(new URL(file, directory), "utf8");
  await database().query(sql);
  console.log(`Applied ${file}`);
}
await database().end();
