import { Octokit } from "@octokit/rest";
import * as cheerio from "cheerio";
import { URL } from "node:url";
import TurndownService from "turndown";

import fetch, { RequestInit } from "node-fetch";

const turndownService = new TurndownService();
turndownService.remove("script");

/**
 * Options for the web crawler.
 */
export interface CrawlOptions {
  /**
   * Extract specific content using CSS selector
   */
  extract?: string;

  /**
   * Maximum number of concurrent connections allowed.
   */
  maxConnections: number;

  /**
   * Path names to exclude
   */
  exclude: string[];

  /**
   * Whether to stop the crawling process on the first encountered error.
   */
  breakOnError: boolean;

  /**
   * Whether to enable logging during the crawling process.
   */
  logEnabled: boolean;

  /**
   * Fetch options
   */
  fetchOptions: RequestInit;
}

const IS_GITHUB_REPO =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)/;

export async function* crawlWebsite(
  startUrl: string,
  options_?: Partial<CrawlOptions>,
): AsyncGenerator<Page, any, Page> {
  const options: CrawlOptions = {
    maxConnections: 5,
    exclude: [],
    fetchOptions: {},
    breakOnError: true,
    logEnabled: true,
    ...(options_ || {}),
  };

  const startUrlObj = new URL(startUrl);
  let paths: string[] = [startUrlObj.pathname];
  startUrl = normalizeStartUrl(startUrl);

  if (IS_GITHUB_REPO.test(startUrl)) {
    paths = await crawlGHTree(startUrlObj, options.exclude);
  }

  let index = 0;
  while (index < paths.length) {
    const batch = paths.slice(index, index + options.maxConnections);

    const promises = batch.map((path) => crawlPage(startUrl, path, options));

    const results = await Promise.all(promises);

    for (const { links, text, path } of results) {
      if (text !== "") {
        yield {
          path: new URL(path, startUrlObj).toString(),
          text,
        };
      }
      for (let link of links) {
        if (!paths.some((path) => matchLink(path, link))) {
          paths.push(link);
        }
      }
    }

    index += batch.length;
  }
  if (options.logEnabled) {
    console.log("✨ Crawl completed");
  }
}

async function crawlGHTree(startUrl: URL, exclude: string[]) {
  const octokit = new Octokit({
    auth: undefined,
  });

  let [_, owner, repo, _scope, branch, ...parts] = startUrl.pathname.split("/");
  const rootPath = parts.join("/");

  const tree = await octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    {
      owner,
      repo,
      tree_sha: branch,
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
      recursive: "true",
    },
  );

  const paths = tree.data.tree
    .filter(
      (file) =>
        file.type === "blob" &&
        (file.path?.endsWith(".md") || file.path?.endsWith(".MD")) &&
        file.path.startsWith(rootPath) &&
        !shouldExcludeLink(file.path, exclude),
    )
    .map(
      (file) =>
        `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file.path}`,
    );

  return paths;
}

export interface Page {
  path: string;
  text: string;
}

async function crawlPage(
  startUrl: string,
  path: string,
  options: CrawlOptions,
) {
  const location = new URL(path, startUrl).toString();

  let html = "";

  try {
    const response = await fetch(location, options.fetchOptions);
    html = await response.text();
    if (options.logEnabled) {
      console.log(`🚀 Crawled ${location}`);
    }
  } catch (err) {
    if (options.breakOnError) {
      throw err;
    } else if (options.logEnabled) {
      console.error(err);
    }
  }

  let links: string[] = [];

  if (IS_GITHUB_REPO.test(startUrl)) {
    return {
      path,
      text: html,
      links,
    };
  }

  const $ = cheerio.load(html);

  $("a").each((_, element) => {
    try {
      const href = $(element).attr("href");
      if (!href || href.startsWith("#")) {
        return;
      }
      const parsedUrl = new URL(href, location);
      if (parsedUrl.toString().startsWith(startUrl)) {
        const link = parsedUrl.pathname;
        if (!shouldExcludeLink(link, options.exclude)) {
          links.push(link);
        }
      }
    } catch {}
  });

  let text = html;
  if (options.extract) {
    text = $(options.extract)?.html();
  }
  text = turndownService.turndown(text);

  return {
    path,
    text,
    links: [...new Set(links)],
  };
}

function shouldExcludeLink(link: string, exclude: string[]) {
  if (link.includes("#")) {
    return true;
  }
  const parts = link.replace(/\/$/, "").split("/");
  let name = (parts[parts.length - 1] || "").toLowerCase();

  for (const excludeName of exclude) {
    let cond = false;
    if (/\.[^.]+$/.test(excludeName)) {
      cond = excludeName.toLowerCase() === name.toLowerCase();
    } else {
      cond =
        excludeName.toLowerCase() ===
        name.toLowerCase().replace(/\.[^.]+$/, "");
    }
    if (cond) {
      return true;
    }
  }
  return false;
}

function normalizeStartUrl(startUrl: string) {
  const parsedUrl = new URL(startUrl);
  parsedUrl.search = "";
  parsedUrl.hash = "";
  let lastSlashIndex = parsedUrl.pathname.lastIndexOf("/");
  if (lastSlashIndex !== -1) {
    parsedUrl.pathname = parsedUrl.pathname.substring(0, lastSlashIndex + 1);
  }
  return parsedUrl.toString();
}

function matchLink(path: string, link: string) {
  return path === link || path === link.replace(/\/index\.(html|htm)$/, "/");
}
