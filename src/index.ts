#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ErrorCode,
    McpError,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import * as cheerio from "cheerio";
import TurndownService from "turndown";

const turndownService = new TurndownService({
    codeBlockStyle: "fenced",
});

interface CrateSearchResult {
    name: string;
    description: string;
    downloads: number;
    version: string;
    documentation: string | null;
}

class DocsRsMcpServer {
    private server: Server;

    constructor() {
        this.server = new Server(
            {
                name: "docs-rs",
                version: "1.0.0",
            },
            {
                capabilities: {
                    tools: {},
                },
            }
        );

        this.setupToolHandlers();
    }

    private setupToolHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "docs_rs_search_crates",
                        description: "Search for Rust crates by keywords on crates.io.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: {
                                    type: "string",
                                    description: "Search keywords for finding relevant crates. Keywords should be in English.",
                                },
                                per_page: {
                                    type: "number",
                                    description: "Number of results per page (default: 10, max: 100)",
                                },
                                sort: {
                                    type: "string",
                                    description: "Sort order: 'relevance', 'downloads', 'recent-downloads', 'recent-updates', 'new' (default: relevance)",
                                },
                            },
                            required: ["query"],
                        },
                    },
                    {
                        name: "docs_rs_readme",
                        description: "Get README/overview content of the specified crate",
                        inputSchema: {
                            type: "object",
                            properties: {
                                crate_name: {
                                    type: "string",
                                    description: "Name of the crate to get README for",
                                },
                                version: {
                                    type: "string",
                                    description: "Specific version (optional, defaults to latest)",
                                },
                            },
                            required: ["crate_name"],
                        },
                    },
                    {
                        name: "docs_rs_get_item",
                        description: "Get documentation content of a specific item (module, struct, trait, enum, function, etc.) within a crate",
                        inputSchema: {
                            type: "object",
                            properties: {
                                crate_name: {
                                    type: "string",
                                    description: "Name of the crate",
                                },
                                item_type: {
                                    type: "string",
                                    description: "Type of item: 'module' for modules, 'struct', 'trait', 'enum', 'type', 'fn', etc.",
                                },
                                item_path: {
                                    type: "string",
                                    description: "The full path of the item, including the module name (e.g. wasmtime::component::Component)",
                                },
                                version: {
                                    type: "string",
                                    description: "Specific version (optional, defaults to latest)",
                                },
                            },
                            required: ["crate_name", "item_type", "item_path"],
                        },
                    },
                    {
                        name: "docs_rs_search_in_crate",
                        description: "Search for traits, structs, methods, etc. from the crate's all.html page. To get a module, use docs_rs_get_item instead.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                crate_name: {
                                    type: "string",
                                    description: "Name of the crate to search",
                                },
                                query: {
                                    type: "string",
                                    description: "Search keyword (trait name, struct name, function name, etc.)",
                                },
                                version: {
                                    type: "string",
                                    description: "Specific version (optional, defaults to latest)",
                                },
                                item_type: {
                                    type: "string",
                                    description: "Filter by item type (struct | trait | fn | enum| union | macro | constant)",
                                },
                            },
                            required: ["crate_name", "query"],
                        },
                    },
                ],
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            try {
                switch (request.params.name) {
                    case "docs_rs_search_crates":
                        return await this.searchCrates(request.params.arguments);
                    case "docs_rs_readme":
                        return await this.getReadMe(request.params.arguments);
                    case "docs_rs_get_item":
                        return await this.getItem(request.params.arguments);
                    case "docs_rs_search_in_crate":
                        return await this.searchInCrate(request.params.arguments);
                    default:
                        throw new McpError(
                            ErrorCode.MethodNotFound,
                            `Unknown tool: ${request.params.name}`
                        );
                }
            } catch (error) {
                throw new McpError(
                    ErrorCode.InternalError,
                    `Error executing tool ${request.params.name}: ${error}`
                );
            }
        });
    }

    private async searchCrates(args: any) {
        const { query, per_page = 10, sort = "relevance" } = args;

        try {
            const response = await axios.get<{ crates: any[] }>("https://crates.io/api/v1/crates", {
                params: {
                    q: query,
                    per_page: Math.min(per_page, 100),
                    sort,
                },
            });

            const crates = response.data.crates.map((crate: any) => ({
                name: crate.name,
                description: crate.description || "No description available",
                downloads: crate.downloads,
                version: crate.newest_version,
                documentation: crate.documentation,
            }));

            return {
                content: [
                    {
                        type: "text",
                        text: `# Crate Search Results for "${query}"\n\n${crates
                            .map(
                                (crate: CrateSearchResult) =>
                                    `## ${crate.name} (${crate.version})\n\n` +
                                    `**Description:** ${crate.description}\n\n` +
                                    `**Downloads:** ${crate.downloads.toLocaleString()}\n\n` +
                                    `**Documentation:** ${crate.documentation || "N/A"}\n\n---\n`
                            )
                            .join("\n")}`,
                    },
                ],
            };
        } catch (error) {
            throw new Error(`Failed to search crates: ${error}`);
        }
    }

    private async getReadMe(args: any) {
        const { crate_name, version = "latest" } = args;

        try {
            const url = `https://docs.rs/${crate_name}/${version}/${crate_name}/index.html`;

            const response = await axios.get<string>(url);
            const $ = cheerio.load(response.data);

            const mainContent = $(".rustdoc .docblock").first();

            if (mainContent.length === 0) {
                const alternativeContent = $(".rustdoc-main .item-decl").first();
                if (alternativeContent.length === 0) {
                    return {
                        content: [
                            {
                                type: "text",
                                text: `# ${crate_name} Documentation\n\nNo documentation content found at ${url}`,
                            },
                        ],
                    };
                }
            }

            const htmlContent = mainContent.html() || "";
            const markdownContent = turndownService.turndown(htmlContent);

            return {
                content: [
                    {
                        type: "text",
                        text: `# ${crate_name} Documentation\n\n${markdownContent}`,
                    },
                ],
            };
        } catch (error) {
            throw new Error(`Failed to get README for ${crate_name}: ${error}`);
        }
    }

    private async getItem(args: any) {
        const { crate_name, item_type, item_path, version = "latest" } = args;

        const item_name = item_path.split("::").pop();

        try {
            let url: string;

            if (item_type === "module") {
                url = `https://docs.rs/${crate_name}/${version}/${item_path.replaceAll("::", "/")}/index.html`;
            } else {
                const pathParts = item_path.split("::");
                const modulePath = pathParts.slice(0, -1).join("/");
                url = `https://docs.rs/${crate_name}/${version}/${modulePath}/${item_type}.${item_name}.html`;
            }

            const response = await axios.get<string>(url);
            const $ = cheerio.load(response.data);

            const mainContentSection = $("#main-content");
            let contentHtml = "";

            if (mainContentSection.length > 0) {
                contentHtml = mainContentSection.html() || "";
            } else {
                const itemDecl = $(".rustdoc .item-decl").first();
                const mainContent = $(".rustdoc .docblock").first();

                if (itemDecl.length > 0) {
                    contentHtml += itemDecl.html() || "";
                }

                if (mainContent.length === 0) {
                    const alternativeContent = $(".rustdoc-main .item-decl").first();
                    if (alternativeContent.length > 0) {
                        contentHtml += alternativeContent.html() || "";
                    }
                } else {
                    contentHtml += mainContent.html() || "";
                }
            }

            if (!contentHtml) {
                const fullItemName = item_path;
                return {
                    content: [
                        {
                            type: "text",
                            text: `# ${fullItemName} (${item_type})\n\nNo documentation content found at ${url}`,
                        },
                    ],
                };
            }

            const markdownContent = turndownService.turndown(contentHtml);

            const fullItemName = item_path;
            return {
                content: [
                    {
                        type: "text",
                        text: `# ${fullItemName} (${item_type})\n\n**Documentation URL:** ${url}\n\n${markdownContent}`,
                    },
                ],
            };
        } catch (error) {
            const fullItemName = item_path;
            throw new Error(`Failed to get item documentation for ${fullItemName}: ${error}`);
        }
    }

    private async searchInCrate(args: any) {
        const { crate_name, query, version = "latest", item_type } = args;

        try {
            const url = `https://docs.rs/${crate_name}/${version}/${crate_name}/all.html`;
            const response = await axios.get<string>(url);
            const $ = cheerio.load(response.data);

            const items: Array<{
                name: string;
                type: string;
                link: string;
            }> = [];

            $("#main-content a").each((_, element) => {
                const $link = $(element);
                const itemName = $link.text().trim();
                const itemLink = $link.attr("href") || "";

                if (!itemName || !itemLink) return;

                let type = "unknown";
                if (itemLink.includes("struct.")) type = "struct";
                else if (itemLink.includes("trait.")) type = "trait";
                else if (itemLink.includes("fn.")) type = "function";
                else if (itemLink.includes("enum.")) type = "enum";
                else if (itemLink.includes("type.")) type = "type";
                else if (itemLink.includes("const.")) type = "constant";
                else if (itemLink.includes("static.")) type = "static";
                else if (itemLink.includes("macro.")) type = "macro";

                const matchesQuery = !query || query == "" || itemName.toLowerCase().includes(query.toLowerCase());
                const matchesType = !item_type || item_type == "" || type === item_type || itemName.toLowerCase().includes(item_type.toLowerCase());

                if (matchesQuery && matchesType && type !== "unknown") {
                    items.push({
                        name: itemName,
                        type,
                        link: itemLink.startsWith("http") ? itemLink : `https://docs.rs/${crate_name}/${version}/${crate_name}/${itemLink}`,
                    });
                }
            });

            const uniqueItems = items.filter((item, index, self) =>
                index === self.findIndex(i => i.name === item.name && i.type === item.type)
            );

            const searchTerm = query || "all items";
            return {
                content: [
                    {
                        type: "text",
                        text: `# Search Results for "${searchTerm}" in ${crate_name}\n\n` +
                            `Found ${uniqueItems.length} items\n\n` +
                            (uniqueItems.length === 0
                                ? "No matching items found."
                                : uniqueItems
                                    .map(
                                        (item) =>
                                            `## ${item.name} (${item.type})\n\n` +
                                            `**Description:** ${item.type}\n\n` +
                                            `**Link:** [View Documentation](${item.link})\n\n` +
                                            `---\n`
                                    )
                                    .join("\n")
                            ),
                    },
                ],
            };
        } catch (error) {
            throw new Error(`Failed to search items in ${crate_name}: ${error}`);
        }
    } async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("docs.rs MCP server running on stdio");
    }
}

const server = new DocsRsMcpServer();
server.run().catch(console.error);
