import Parser from "rss-parser";

// rss-parser の薄いラッパー。RSS / Atom の両方をパースできる。
const parser = new Parser({
  timeout: 15000,
  headers: { "User-Agent": "rss-reader/0.1 (+personal use)" },
});

export type ParsedItem = Parser.Item;
export type ParsedFeed = Parser.Output<Parser.Item>;

export async function fetchAndParse(url: string): Promise<ParsedFeed> {
  return parser.parseURL(url);
}
