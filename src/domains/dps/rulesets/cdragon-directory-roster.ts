import { parseDocument, DomUtils } from "htmlparser2";
import { SourceArtifactSchema, hashCanonical } from "../contracts/index.ts";
import { discoverDataDragonIndex } from "./ddragon-discovery.ts";
import { assertPinnedSourceArtifactUrl, hashRetainedSourceBytes } from "./source-validation.ts";

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

type ListingElement = import("domhandler").Element;

async function parsedListing(html: string) {
  const document = parseDocument(html, { decodeEntities: false });
  const elements = DomUtils.findAll((node) => node.type === "tag" || node.type === "script" || node.type === "style", document.children);
  const tag = (node: ListingElement, name: string) => node.name === name;
  const parent = (node: ListingElement, name: string) => node.parent?.type === "tag" && node.parent.name === name;
  const beneath = (node: ListingElement, ancestor: ListingElement) => {
    let current = node.parent;
    while (current) {
      if (current === ancestor) return true;
      current = current.parent;
    }
    return false;
  };
  const count = (name: string) => elements.filter((node) => tag(node, name)).length;
  const main = elements.filter((node) => tag(node, "main") && parent(node, "body"));
  const headings = elements.filter((node) => tag(node, "h1") && main.some((root) => node.parent === root));
  const tables = elements.filter((node) => tag(node, "table") && node.attribs.id === "list" && main.some((root) => node.parent === root));
  const table = tables[0];
  const descendants = table ? elements.filter((node) => beneath(node, table)) : [];
  const bodies = descendants.filter((node) => tag(node, "tbody") && node.parent === table);
  const rows = descendants.filter((node) => tag(node, "tr") && bodies.some((body) => node.parent === body)).map((row) => {
    const children = elements.filter((node) => node.parent === row && (tag(node, "td") || tag(node, "th")));
    const cells = (role: string) => children.filter((node) => tag(node, "td") && (node.attribs.class ?? "").split(/\s+/).includes(role));
    const links = elements.filter((node) => tag(node, "a") && cells("link").some((cell) => node.parent === cell));
    return {
      cellCount: children.length,
      cellRoles: children.map((node) => tag(node, "th") ? "#th" : node.attribs.class ?? null),
      linkCellCount: cells("link").length,
      linkCellText: cells("link").map((node) => DomUtils.textContent(node)).join(""),
      sizeCellCount: cells("size").length,
      dateCellCount: cells("date").length,
      anchorCount: elements.filter((node) => tag(node, "a") && beneath(node, row)).length,
      links: links.map((node) => ({ href: node.attribs.href ?? null, title: node.attribs.title ?? null, label: DomUtils.textContent(node) })),
    };
  });
  const hasAttribute = (node: ListingElement, attribute: string) => Object.hasOwn(node.attribs, attribute);
  const inBody = (node: ListingElement) => elements.some((root) => tag(root, "body") && beneath(node, root));
  return {
    bodyCount: count("body"),
    mainCount: main.length,
    allHeadingCount: elements.filter((node) => tag(node, "h1") && inBody(node)).length,
    headingCount: headings.length,
    heading: headings.map((node) => DomUtils.textContent(node)).join(""),
    headingOrder: headings[0] ? elements.indexOf(headings[0]) : 0,
    tableCount: tables.length,
    allTableCount: elements.filter((node) => tag(node, "table") && node.attribs.id === "list" && inBody(node)).length,
    tableOrder: table ? elements.indexOf(table) : 0,
    tableBodyCount: bodies.length,
    tableAnchorCount: descendants.filter((node) => tag(node, "a")).length,
    sortHrefs: descendants.filter((node) => tag(node, "a") && parent(node, "th") && node.parent?.parent?.type === "tag" && node.parent.parent.name === "tr" && node.parent.parent.parent?.type === "tag" && node.parent.parent.parent.name === "thead" && node.parent.parent.parent.parent === table).map((node) => node.attribs.href ?? null),
    templateCount: count("template"),
    canvasCount: count("canvas"),
    baseCount: count("base"),
    styleElementCount: count("style"),
    hiddenCount: elements.filter((node) => hasAttribute(node, "hidden")).length,
    styledStructureCount: elements.filter((node) => hasAttribute(node, "style") && (["html", "body", "main", "h1"].includes(node.name) || (tag(node, "table") && node.attribs.id === "list") || (descendants.includes(node) && !tag(node, "th")))).length,
    rows,
  };
}

async function discoverCharacterDirectories(rawArtifact: unknown, bytes: Uint8Array) {
  const artifact = SourceArtifactSchema.parse(rawArtifact);
  if (artifact.kind !== "community-dragon")
    throw new TypeError("character directory requires a CommunityDragon artifact");
  const url = assertPinnedSourceArtifactUrl(artifact);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(artifact.version) ||
    url.pathname !== `/${artifact.version}/game/data/characters/` ||
    artifact.uri.includes("?") ||
    artifact.version.toLowerCase() === "pbe"
  )
    throw new TypeError("character directory requires a pinned CommunityDragon listing URL");
  const retained = Uint8Array.from(bytes);
  if ((await hashRetainedSourceBytes(retained)) !== artifact.contentHash)
    throw new TypeError("CommunityDragon character directory bytes do not match the artifact hash");
  const html = new TextDecoder("utf-8", { fatal: true }).decode(retained);
  const listing = await parsedListing(html);
  if (
    listing.templateCount ||
    listing.canvasCount ||
    listing.baseCount ||
    listing.styleElementCount ||
    listing.hiddenCount ||
    listing.styledStructureCount
  )
    throw new TypeError("character directory contains inert, base URL, hidden or styled elements");
  if (
    listing.bodyCount !== 1 ||
    listing.mainCount !== 1 ||
    listing.allHeadingCount !== 1 ||
    listing.headingCount !== 1 ||
    listing.heading.trim() !== url.pathname
  )
    throw new TypeError("CommunityDragon directory heading conflicts with its pinned URL");
  if (
    listing.tableCount !== 1 ||
    listing.allTableCount !== 1 ||
    listing.tableBodyCount !== 1 ||
    listing.tableOrder <= listing.headingOrder
  )
    throw new TypeError("character directory requires one listing table after its heading");
  if (listing.rows.length < 2) throw new TypeError("character directory has missing listing rows");
  const expectedSortHrefs = [
    "?C=M&amp;O=A",
    "?C=M&amp;O=D",
    "?C=N&amp;O=A",
    "?C=N&amp;O=D",
    "?C=S&amp;O=A",
    "?C=S&amp;O=D",
  ];
  if (
    listing.tableAnchorCount !== listing.rows.length + listing.sortHrefs.length ||
    (listing.sortHrefs.length !== 0 &&
      (listing.sortHrefs.length !== expectedSortHrefs.length ||
        listing.sortHrefs
          .map((href) => href ?? "")
          .sort(compare)
          .join("\n") !== expectedSortHrefs.join("\n")))
  )
    throw new TypeError("character directory contains anchors outside its listing rows");
  const directories: string[] = [];
  let parentCount = 0;
  for (const row of listing.rows) {
    if (
      row.cellCount !== 3 ||
      row.cellRoles.join(",") !== "link,size,date" ||
      row.linkCellCount !== 1 ||
      row.sizeCellCount !== 1 ||
      row.dateCellCount !== 1 ||
      row.anchorCount !== 1 ||
      row.links.length !== 1 ||
      row.linkCellText !== row.links[0]!.label
    )
      throw new TypeError("character directory contains a malformed listing row");
    const { href, title, label } = row.links[0]!;
    if (href === "../" && title === null && label === "Parent directory/") {
      parentCount++;
      continue;
    }
    if (!href || !/^[a-z0-9_]+\/$/.test(href) || title !== href.slice(0, -1) || label !== href)
      throw new TypeError(`character directory contains an unsafe or conflicting link ${href}`);
    directories.push(href.slice(0, -1));
  }
  if (
    parentCount !== 1 ||
    directories.length === 0 ||
    new Set(directories).size !== directories.length
  )
    throw new TypeError("character directory requires one parent and unique source links");
  return { artifact, directories: directories.sort(compare) };
}

/** Match exact directory names to a verified Data Dragon roster; extras remain unclassified. */
export async function discoverCommunityDragonDirectoryRoster(
  rawChampionIndexArtifact: unknown,
  championIndexBytes: Uint8Array,
  rawDirectoryArtifact: unknown,
  directoryBytes: Uint8Array,
) {
  const stableIndex = Uint8Array.from(championIndexBytes);
  const stableDirectory = Uint8Array.from(directoryBytes);
  const [index, listing] = await Promise.all([
    discoverDataDragonIndex(rawChampionIndexArtifact, stableIndex),
    discoverCharacterDirectories(rawDirectoryArtifact, stableDirectory),
  ]);
  if (index.kind !== "champion-index")
    throw new TypeError("directory roster requires a Data Dragon champion index");
  if (index.artifact.uri.includes("?"))
    throw new TypeError("directory roster requires a query-free Data Dragon champion index URL");
  if (index.artifact.artifactId === listing.artifact.artifactId)
    throw new TypeError("directory roster requires distinct source artifact IDs");
  const available = new Set(listing.directories);
  const missing = index.entries.filter((entry) => !available.has(entry.slug.toLowerCase()));
  if (missing.length)
    throw new TypeError(
      `CommunityDragon directory missing roster slugs: ${missing.map((entry) => entry.slug).join(", ")}`,
    );
  const rosterNames = new Set(index.entries.map((entry) => entry.slug.toLowerCase()));
  if (rosterNames.size !== index.entries.length)
    throw new TypeError("Data Dragon roster slugs conflict after directory normalization");
  const body = {
    schemaVersion: 1 as const,
    scope: "community-dragon-directory-roster-only" as const,
    pcPatchMappingReviewed: false as const,
    combatComplete: false as const,
    sources: {
      championIndex: {
        artifactId: index.artifact.artifactId,
        uri: index.artifact.uri,
        version: index.artifact.version,
        contentHash: index.artifact.contentHash,
      },
      characterDirectory: {
        artifactId: listing.artifact.artifactId,
        uri: listing.artifact.uri,
        revision: listing.artifact.version,
        contentHash: listing.artifact.contentHash,
      },
    },
    rosterDirectories: index.entries.map((entry) => ({
      id: entry.id,
      slug: entry.slug,
      championIndexPointer: entry.sourcePointer,
      directoryHref: `${entry.slug.toLowerCase()}/`,
    })),
    unclassifiedDirectoryHrefs: listing.directories
      .filter((slug) => !rosterNames.has(slug))
      .map((slug) => `${slug}/`),
  };
  return { ...body, rosterHash: await hashCanonical(body) };
}

export type CommunityDragonDirectoryRoster = Awaited<
  ReturnType<typeof discoverCommunityDragonDirectoryRoster>
>;
