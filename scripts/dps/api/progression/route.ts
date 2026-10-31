import { getYunaraProgression } from "../../data/progression.ts";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const champion = url.searchParams.get("champion") ?? "Yunara";
    if (champion.toLowerCase() !== "yunara") {
      return Response.json(
        { error: "Only Yunara progression is available in this prototype." },
        { status: 400 },
      );
    }
    const rawLevel = Number(url.searchParams.get("level") ?? 13);
    if (!Number.isInteger(rawLevel) || rawLevel < 1 || rawLevel > 18) {
      return Response.json(
        { error: "level must be an integer from 1 to 18." },
        { status: 400 },
      );
    }
    const data = await getYunaraProgression(rawLevel);
    return Response.json(data, {
      headers: { "cache-control": "private, max-age=60" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Progression query failed" },
      { status: 400 },
    );
  }
}
